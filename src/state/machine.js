/**
 * State machine for CodeAssist AI session phases.
 * Manages transitions between idle, reading_question, coding, error_detected, etc.
 * @module stateMachine
 */

const logger = require('../utils/logger');
const sessionStore = require('./session');

/**
 * Valid states.
 * @enum {string}
 */
const STATES = {
  IDLE: 'idle',
  READING_QUESTION: 'reading_question',
  SOLUTION_GENERATED: 'solution_generated',
  MONITORING: 'monitoring',
  ERROR_DETECTED: 'error_detected',
  FIX_GENERATED: 'fix_generated',
  NEW_QUESTION_DETECTED: 'new_question_detected',
};

const MAX_ERROR_CYCLES = 3;
const UNREADABLE_THRESHOLD = 10;
const UNCHANGED_TO_MONITORING = 5;

/**
 * Process an AI response and transition the session state accordingly.
 * @param {string} sessionId - Session UUID
 * @param {Object} aiResponse - Parsed AI response with phase, solution, error, etc.
 * @returns {Object} Action result with updated phase and data for the client
 */
function processResponse(sessionId, aiResponse) {
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    return { action: 'error', error: 'Session not found' };
  }

  const previousPhase = session.currentPhase;
  const detectedPhase = aiResponse.phase || 'idle';

  logger.debug('State machine processing', {
    sessionId,
    previousPhase,
    detectedPhase,
    questionNumber: session.questionNumber,
  });

  if (detectedPhase === 'idle') {
    return handleIdle(session, aiResponse);
  }

  if (detectedPhase === 'new_question' || isNewQuestion(session, aiResponse)) {
    return handleNewQuestion(session, aiResponse);
  }

  if (detectedPhase === 'reading_question') {
    return handleReadingQuestion(session, aiResponse);
  }

  if (detectedPhase === 'error_detected') {
    return handleErrorDetected(session, aiResponse);
  }

  if (detectedPhase === 'coding') {
    return handleCoding(session, aiResponse);
  }

  return handleIdle(session, aiResponse);
}

/**
 * Determine if the AI response indicates a new question.
 * @param {Object} session - Current session
 * @param {Object} aiResponse - AI response
 * @returns {boolean}
 */
function isNewQuestion(session, aiResponse) {
  const newTitle = (aiResponse.problemTitle || '').trim().toLowerCase();
  const currentTitle = (session.currentProblemTitle || '').trim().toLowerCase();

  if (!newTitle || !currentTitle) return false;
  if (newTitle === currentTitle) return false;

  const similarity = computeTextSimilarity(
    aiResponse.extractedText || '',
    session.currentProblemContext || ''
  );
  return similarity < 0.4;
}

/**
 * Rough text similarity using Jaccard index on word sets.
 * @param {string} textA
 * @param {string} textB
 * @returns {number} Similarity ratio 0-1
 */
function computeTextSimilarity(textA, textB) {
  if (!textA || !textB) return 0;
  const setA = new Set(textA.toLowerCase().split(/\s+/));
  const setB = new Set(textB.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Handle idle state — screen not readable or non-assessment content.
 * If unreadable for 10+ consecutive frames, force reset to IDLE with warning.
 * @param {Object} session
 * @param {Object} aiResponse
 * @returns {Object}
 */
function handleIdle(session, aiResponse) {
  session.unchangedFrameCount++;

  // Even if phase is "idle", if Gemini generated a solution, return it
  if (aiResponse.solution) {
    sessionStore.updateSession(session.id, {
      currentPhase: STATES.SOLUTION_GENERATED,
      lastSolutionCode: aiResponse.solution.optimalCode || aiResponse.solution.code || '',
      lastModelUsed: aiResponse._modelUsed || session.lastModelUsed,
      unchangedFrameCount: 0,
    });

    if (session.questionNumber === 0) {
      sessionStore.updateSession(session.id, { questionNumber: 1 });
    }

    return {
      action: 'solution',
      phase: STATES.SOLUTION_GENERATED,
      questionNumber: session.questionNumber || 1,
      difficulty: aiResponse.difficulty || 'medium',
      extractedText: aiResponse.extractedText || '',
      solution: aiResponse.solution,
      timestamp: new Date().toISOString(),
    };
  }

  const unreadableTooLong = session.unchangedFrameCount >= UNREADABLE_THRESHOLD;

  if (unreadableTooLong && session.currentPhase !== STATES.IDLE) {
    logger.warn('Unreadable for 10+ frames, forcing IDLE', { sessionId: session.id });
  }

  sessionStore.updateSession(session.id, {
    currentPhase: STATES.IDLE,
    unchangedFrameCount: session.unchangedFrameCount,
  });

  return {
    action: 'monitoring',
    phase: STATES.IDLE,
    questionNumber: session.questionNumber,
    extractedText: aiResponse.extractedText || 'Screen not readable',
    unreadableTooLong,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Handle new question detection.
 * @param {Object} session
 * @param {Object} aiResponse
 * @returns {Object}
 */
function handleNewQuestion(session, aiResponse) {
  const newQuestionNumber = Math.min(session.questionNumber + 1, 4);

  // Store question text for history
  if (aiResponse.extractedText) {
    session.questionTexts.push({
      questionNumber: newQuestionNumber,
      title: aiResponse.problemTitle || '',
      text: aiResponse.extractedText,
    });
  }

  sessionStore.updateSession(session.id, {
    currentPhase: STATES.NEW_QUESTION_DETECTED,
    questionNumber: newQuestionNumber,
    currentProblemTitle: aiResponse.problemTitle || '',
    currentProblemContext: aiResponse.extractedText || '',
    errorCycleCount: 0,
    lastSolutionCode: '',
    unchangedFrameCount: 0,
    questionTexts: session.questionTexts,
  });

  logger.info('New question detected', {
    sessionId: session.id,
    questionNumber: newQuestionNumber,
    title: aiResponse.problemTitle,
  });

  if (aiResponse.solution) {
    sessionStore.updateSession(session.id, {
      currentPhase: STATES.SOLUTION_GENERATED,
      lastSolutionCode: aiResponse.solution.optimalCode || aiResponse.solution.code || '',
      lastModelUsed: aiResponse._modelUsed || session.lastModelUsed,
    });

    session.solutions.push({
      questionNumber: newQuestionNumber,
      solution: aiResponse.solution,
      timestamp: new Date().toISOString(),
    });

    return {
      action: 'new_question',
      phase: STATES.SOLUTION_GENERATED,
      questionNumber: newQuestionNumber,
      difficulty: aiResponse.difficulty || 'medium',
      extractedText: aiResponse.extractedText || '',
      solution: aiResponse.solution,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    action: 'new_question',
    phase: STATES.READING_QUESTION,
    questionNumber: newQuestionNumber,
    difficulty: aiResponse.difficulty || 'medium',
    extractedText: aiResponse.extractedText || '',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Handle reading question / generating solution.
 * @param {Object} session
 * @param {Object} aiResponse
 * @returns {Object}
 */
function handleReadingQuestion(session, aiResponse) {
  const questionNumber = session.questionNumber || 1;

  if (session.questionNumber === 0) {
    sessionStore.updateSession(session.id, { questionNumber: 1 });
  }

  sessionStore.updateSession(session.id, {
    currentPhase: aiResponse.solution ? STATES.SOLUTION_GENERATED : STATES.READING_QUESTION,
    currentProblemTitle: aiResponse.problemTitle || session.currentProblemTitle,
    currentProblemContext: aiResponse.extractedText || session.currentProblemContext,
    unchangedFrameCount: 0,
    errorCycleCount: 0,
  });

  if (aiResponse.solution) {
    sessionStore.updateSession(session.id, {
      lastSolutionCode: aiResponse.solution.optimalCode || aiResponse.solution.code || '',
      lastModelUsed: aiResponse._modelUsed || session.lastModelUsed,
    });

    session.solutions.push({
      questionNumber: session.questionNumber || 1,
      solution: aiResponse.solution,
      timestamp: new Date().toISOString(),
    });

    return {
      action: 'solution',
      phase: STATES.SOLUTION_GENERATED,
      questionNumber: session.questionNumber || 1,
      difficulty: aiResponse.difficulty || 'easy',
      extractedText: aiResponse.extractedText || '',
      solution: aiResponse.solution,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    action: 'monitoring',
    phase: STATES.READING_QUESTION,
    questionNumber: session.questionNumber || 1,
    difficulty: aiResponse.difficulty || 'easy',
    extractedText: aiResponse.extractedText || '',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Handle error detection.
 * @param {Object} session
 * @param {Object} aiResponse
 * @returns {Object}
 */
function handleErrorDetected(session, aiResponse) {
  session.errorCount++;
  session.errorCycleCount++;

  const needsEscalation = session.errorCycleCount >= MAX_ERROR_CYCLES;

  sessionStore.updateSession(session.id, {
    currentPhase: STATES.ERROR_DETECTED,
    errorCount: session.errorCount,
    errorCycleCount: session.errorCycleCount,
    unchangedFrameCount: 0,
  });

  logger.info('Error detected', {
    sessionId: session.id,
    errorCycleCount: session.errorCycleCount,
    needsEscalation,
  });

  if (aiResponse.error && aiResponse.error.fixedCode) {
    sessionStore.updateSession(session.id, {
      currentPhase: STATES.FIX_GENERATED,
      lastSolutionCode: aiResponse.error.fixedCode,
    });

    return {
      action: 'error_fix',
      phase: STATES.FIX_GENERATED,
      questionNumber: session.questionNumber,
      extractedText: aiResponse.extractedText || '',
      error: aiResponse.error,
      needsEscalation,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    action: 'error_fix',
    phase: STATES.ERROR_DETECTED,
    questionNumber: session.questionNumber,
    extractedText: aiResponse.extractedText || '',
    error: aiResponse.error || { errorText: 'Unknown error', cause: 'Could not parse error', fixedCode: '' },
    needsEscalation,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Handle coding phase — user is typing.
 * IMPORTANT: Even in coding phase, if Gemini generated a solution (because it saw problem text),
 * we still return that solution to the client.
 * @param {Object} session
 * @param {Object} aiResponse
 * @returns {Object}
 */
function handleCoding(session, aiResponse) {
  session.unchangedFrameCount++;

  // If Gemini included a solution even during "coding" phase, treat it as a solution
  if (aiResponse.solution) {
    sessionStore.updateSession(session.id, {
      currentPhase: STATES.SOLUTION_GENERATED,
      lastSolutionCode: aiResponse.solution.optimalCode || aiResponse.solution.code || '',
      lastModelUsed: aiResponse._modelUsed || session.lastModelUsed,
      unchangedFrameCount: 0,
    });

    if (session.questionNumber === 0) {
      sessionStore.updateSession(session.id, { questionNumber: 1 });
    }

    return {
      action: 'solution',
      phase: STATES.SOLUTION_GENERATED,
      questionNumber: session.questionNumber || 1,
      difficulty: aiResponse.difficulty || 'medium',
      extractedText: aiResponse.extractedText || '',
      solution: aiResponse.solution,
      timestamp: new Date().toISOString(),
    };
  }

  const shouldTransitionToMonitoring = session.unchangedFrameCount >= UNCHANGED_TO_MONITORING;
  const nextPhase = shouldTransitionToMonitoring ? STATES.MONITORING : STATES.SOLUTION_GENERATED;

  sessionStore.updateSession(session.id, {
    currentPhase: nextPhase,
    unchangedFrameCount: session.unchangedFrameCount,
  });

  return {
    action: 'monitoring',
    phase: nextPhase,
    questionNumber: session.questionNumber,
    extractedText: aiResponse.extractedText || '',
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  STATES,
  processResponse,
  isNewQuestion,
  computeTextSimilarity,
  MAX_ERROR_CYCLES,
};
