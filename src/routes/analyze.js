/**
 * Frame analysis endpoint — the CORE of CodeAssist AI.
 * Features: frame diffing, solution caching per question, fast error detection.
 * @module routes/analyze
 */

const express = require('express');
const router = express.Router();
const sessionStore = require('../state/session');
const stateMachine = require('../state/machine');
const orchestrator = require('../services/orchestrator');
const imageHash = require('../utils/imageHash');
const logger = require('../utils/logger');

const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD) || 0.85;

/**
 * POST /api/analyze
 * Body: { sessionId, frame (base64 JPEG), frameHash? }
 */
router.post('/', async (req, res) => {
  const startTime = Date.now();

  try {
    const { sessionId, frame, frameHash } = req.body;

    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    if (!frame) return res.status(400).json({ error: 'frame (base64 image) is required' });

    const session = sessionStore.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found. Start a new session.' });

    session.totalFramesSent++;
    sessionStore.updateSession(sessionId, { totalFramesSent: session.totalFramesSent });

    // Frame diffing — skip if frame hasn't changed
    let computedHash = frameHash;
    if (!computedHash) {
      try {
        const imageBuffer = Buffer.from(frame, 'base64');
        computedHash = await imageHash.computeHash(imageBuffer);
      } catch (hashErr) {
        logger.warn('Hash computation failed', { error: hashErr.message });
      }
    }

    if (computedHash && session.previousFrameHash) {
      const sim = imageHash.similarity(computedHash, session.previousFrameHash);
      if (sim > SIMILARITY_THRESHOLD) {
        session.unchangedFrameCount++;
        sessionStore.updateSession(sessionId, {
          previousFrameHash: computedHash,
          unchangedFrameCount: session.unchangedFrameCount,
        });

        return res.json({
          action: 'skip',
          reason: 'no_change',
          similarity: sim,
          phase: session.currentPhase,
          questionNumber: session.questionNumber,
          timestamp: new Date().toISOString(),
        });
      }
    }

    sessionStore.updateSession(sessionId, {
      previousFrameHash: computedHash,
      unchangedFrameCount: 0,
    });

    // SMART CACHING: If we have a cached solution for the current question
    // and the session is stable, send frame for phase detection only.
    // If it detects same question → return cache. New question or error → full process.
    const currentPhase = session.currentPhase;
    const hasSolution = session.lastSolutionCode && session.lastSolutionCode.length > 0;
    const isStablePhase = ['solution_generated', 'monitoring'].includes(currentPhase);

    // Always do full analysis — the AI will determine what's on screen
    const aiResponse = await orchestrator.analyzeFrame(sessionId, frame);
    const detectedPhase = aiResponse.phase || 'idle';

    // ERROR FAST PATH: If error detected, process immediately (no caching)
    if (detectedPhase === 'error_detected') {
      const result = stateMachine.processResponse(sessionId, aiResponse);
      const elapsed = Date.now() - startTime;
      logger.info('Error detected - fast path', { sessionId, elapsed });
      return res.json(result);
    }

    // NEW QUESTION: If AI sees a different question, process and cache new solution
    if (detectedPhase === 'new_question' || stateMachine.isNewQuestion(session, aiResponse)) {
      const result = stateMachine.processResponse(sessionId, aiResponse);

      // Cache the solution by question number
      if (result.solution) {
        cacheSolution(session, result.questionNumber, result.solution, result.difficulty);
      }

      const elapsed = Date.now() - startTime;
      logger.info('New question detected', { sessionId, elapsed, questionNumber: result.questionNumber });
      return res.json(result);
    }

    // SAME QUESTION + HAS SOLUTION: Return cached solution
    if (hasSolution && isStablePhase && (detectedPhase === 'reading_question' || detectedPhase === 'coding' || detectedPhase === 'idle')) {
      // Check if this is a question we've seen before (switch-back detection)
      const cachedForTitle = getCachedSolution(session, aiResponse.problemTitle);
      if (cachedForTitle) {
        const elapsed = Date.now() - startTime;
        logger.info('Returning cached solution (switch-back)', {
          sessionId, elapsed, questionNumber: cachedForTitle.questionNumber,
        });
        return res.json({
          action: 'solution',
          phase: 'solution_generated',
          questionNumber: cachedForTitle.questionNumber,
          difficulty: cachedForTitle.difficulty,
          solution: cachedForTitle.solution,
          cachedSolution: true,
          timestamp: new Date().toISOString(),
        });
      }

      // Same question, same solution — just monitoring
      return res.json({
        action: 'monitoring',
        phase: 'solution_generated',
        questionNumber: session.questionNumber,
        cachedSolution: true,
        timestamp: new Date().toISOString(),
      });
    }

    // FIRST SOLUTION: No cached solution yet, process the AI response
    const result = stateMachine.processResponse(sessionId, aiResponse);

    // Cache if we got a solution
    if (result.solution) {
      cacheSolution(session, result.questionNumber || session.questionNumber, result.solution, result.difficulty);
    }

    const elapsed = Date.now() - startTime;
    logger.info('Frame analyzed', {
      sessionId, elapsed,
      action: result.action, phase: result.phase,
      questionNumber: result.questionNumber,
      model: aiResponse._modelUsed,
    });

    res.json(result);
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error('Frame analysis failed', { error: err.message, elapsed, sessionId: req.body?.sessionId });

    const isRateLimit = err.message && (err.message.includes('429') || err.message.includes('quota'));
    res.status(isRateLimit ? 429 : 500).json({
      action: 'monitoring',
      phase: 'idle',
      error: err.message ? err.message.substring(0, 300) : 'Unknown error',
      isRateLimit,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Cache a solution by question number and title for instant recall.
 * @param {Object} session
 * @param {number} questionNumber
 * @param {Object} solution
 * @param {string} difficulty
 */
function cacheSolution(session, questionNumber, solution, difficulty) {
  if (!session._solutionCache) session._solutionCache = {};
  const key = questionNumber || 0;
  session._solutionCache[key] = {
    questionNumber,
    solution,
    difficulty,
    title: session.currentProblemTitle || '',
    cachedAt: Date.now(),
  };
  logger.info('Solution cached', { sessionId: session.id, questionNumber, title: session.currentProblemTitle });
}

/**
 * Look up a cached solution by problem title (for switch-back detection).
 * @param {Object} session
 * @param {string} problemTitle
 * @returns {Object|null}
 */
function getCachedSolution(session, problemTitle) {
  if (!session._solutionCache || !problemTitle) return null;
  const titleLower = (problemTitle || '').trim().toLowerCase();
  if (!titleLower) return null;

  for (const entry of Object.values(session._solutionCache)) {
    const cachedTitle = (entry.title || '').trim().toLowerCase();
    if (cachedTitle && cachedTitle === titleLower) {
      return entry;
    }
  }
  return null;
}

module.exports = router;
