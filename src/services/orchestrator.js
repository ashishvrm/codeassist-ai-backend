/**
 * AI Model Orchestrator — routes requests to the appropriate AI model.
 * Implements the routing decision tree, fallback logic, and rate limiting.
 * @module orchestrator
 */

const gemini = require('./gemini');
const openai = require('./openai');
const groq = require('./groq');
const openrouter = require('./openrouter');
const prompts = require('./prompts');
const sessionStore = require('../state/session');
const logger = require('../utils/logger');
const sharp = require('sharp');

/** Rate limiting state for Gemini free tier */
const rateLimiter = {
  callsThisMinute: 0,
  callsToday: 0,
  minuteStart: Date.now(),
  dayStart: Date.now(),
  MAX_PER_MINUTE: 15,
  MAX_PER_DAY: 1000,
  WARN_PER_MINUTE: 12,
  WARN_PER_DAY: 900,
};

/**
 * Reset rate limiter counters as needed.
 */
function checkRateLimits() {
  const now = Date.now();
  if (now - rateLimiter.minuteStart > 60000) {
    rateLimiter.callsThisMinute = 0;
    rateLimiter.minuteStart = now;
  }
  if (now - rateLimiter.dayStart > 86400000) {
    rateLimiter.callsToday = 0;
    rateLimiter.dayStart = now;
  }
}

/**
 * Increment rate limiter counters.
 * @param {'gemini'|'openai'} model
 */
function recordCall(model) {
  if (model === 'gemini') {
    rateLimiter.callsThisMinute++;
    rateLimiter.callsToday++;
  }
}

/**
 * Check if Gemini is currently rate-limited.
 * @returns {{ limited: boolean, reason: string|null }}
 */
function isGeminiRateLimited() {
  checkRateLimits();
  if (rateLimiter.callsThisMinute >= rateLimiter.MAX_PER_MINUTE) {
    return { limited: true, reason: 'minute_limit' };
  }
  if (rateLimiter.callsToday >= rateLimiter.MAX_PER_DAY) {
    return { limited: true, reason: 'daily_limit' };
  }
  return { limited: false, reason: null };
}

/**
 * Determine which model to use based on session state and routing rules.
 * @param {Object} session - Current session
 * @param {string} detectedPhase - Phase detected from previous analysis or frame
 * @returns {'gemini'|'openai'} Model to use
 */
function selectModel(session, detectedPhase) {
  // If OpenAI is not configured, always use Gemini
  if (!openai.isAvailable()) {
    return 'gemini';
  }

  // If Gemini is rate limited, use OpenAI
  const rateStatus = isGeminiRateLimited();
  if (rateStatus.limited) {
    logger.warn('Gemini rate limited, using OpenAI', { reason: rateStatus.reason });
    return 'openai';
  }

  // If Gemini is not available, use OpenAI
  if (!gemini.isAvailable()) {
    return 'openai';
  }

  // Idle/coding/monitoring — use Gemini (cheap, just monitoring)
  if (['idle', 'coding', 'monitoring'].includes(detectedPhase)) {
    return 'gemini';
  }

  // Error detection — use same model that generated original, or escalate
  if (detectedPhase === 'error_detected') {
    if (session.errorCycleCount >= 3) {
      // Hard problem escalation after 3 failures — always use GPT-4o
      return 'openai';
    }
    if (session.errorCycleCount >= 2) {
      // Switch models after 2 failures
      return session.lastModelUsed === 'gemini' ? 'openai' : 'gemini';
    }
    return session.lastModelUsed || 'gemini';
  }

  // Question reading — route by difficulty/question number
  // Q1=1, Q2=2 → Gemini; Q3=3, Q4=4 → GPT-4o
  if (['reading_question', 'new_question'].includes(detectedPhase)) {
    if (session.questionNumber >= 3) {
      return 'openai'; // Q3-Q4 hard problems → GPT-4o
    }
    return 'gemini'; // Q1-Q2 easy/medium → Gemini
  }

  return 'gemini';
}

/**
 * Preprocess the image for optimal AI consumption.
 * @param {string} base64Image - Raw base64 JPEG from client
 * @returns {Promise<string>} Processed base64 JPEG
 */
async function preprocessImage(base64Image) {
  try {
    const inputBuffer = Buffer.from(base64Image, 'base64');
    const processedBuffer = await sharp(inputBuffer)
      .resize(1024, null, { withoutEnlargement: true, fit: 'inside' })
      .jpeg({ quality: 85 })
      .sharpen({ sigma: 1.0 })
      .normalize()
      .toBuffer();
    return processedBuffer.toString('base64');
  } catch (err) {
    logger.warn('Image preprocessing failed, using original', { error: err.message });
    return base64Image;
  }
}

/**
 * Build the appropriate prompt based on session state.
 * IMPORTANT: The frame analysis prompt handles ALL phase detection and solution generation.
 * We only use specialized prompts for error recovery (when we already know the error context)
 * and hard problem escalation (Q3-Q4 with known problem text).
 * @param {Object} session - Current session
 * @param {string} phase - Previous session phase (hint only)
 * @returns {string} Prompt string
 */
function buildPrompt(session, phase) {
  const language = session.language || process.env.PREFERRED_LANGUAGE || 'python';
  const history = prompts.formatConversationHistory(session.conversationHistory);

  // Error recovery after failed fix — only use specialized prompt if we have code + error context
  if (phase === 'error_detected' && session.errorCycleCount > 0 && session.lastSolutionCode) {
    if (session.errorCycleCount >= 3) {
      return prompts.buildCycleBreakerPrompt({
        language,
        problemContext: session.currentProblemContext,
        failedAttempts: `Attempt count: ${session.errorCycleCount}. Last code:\n${session.lastSolutionCode}`,
      });
    }
    return prompts.buildErrorRecoveryPrompt({
      language,
      previousCode: session.lastSolutionCode,
      extractedError: session.previousFrameText || 'Error visible on screen',
      problemContext: session.currentProblemContext,
    });
  }

  // ALWAYS use the frame analysis prompt — it handles phase detection, solution generation,
  // and error fixing all in one. This is critical: every frame gets the full prompt so Gemini
  // can detect what's on screen and respond appropriately regardless of previous state.
  return prompts.buildFrameAnalysisPrompt({
    language,
    conversationHistory: history,
    questionNumber: session.questionNumber,
  });
}

/**
 * Main orchestration function — analyze a frame using the appropriate AI model.
 * @param {string} sessionId - Session UUID
 * @param {string} base64Image - Base64-encoded JPEG frame
 * @returns {Promise<Object>} AI response with _modelUsed field added
 */
async function analyzeFrame(sessionId, base64Image) {
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  session.totalApiCalls++;
  sessionStore.updateSession(sessionId, { totalApiCalls: session.totalApiCalls });

  // Preprocess image
  const processedImage = await preprocessImage(base64Image);

  // Determine current phase hint from session state
  const phaseHint = session.currentPhase || 'idle';

  // Select model
  const selectedModel = selectModel(session, phaseHint);

  // Build prompt
  const prompt = buildPrompt(session, phaseHint);

  logger.info('Orchestrator dispatching', {
    sessionId,
    model: selectedModel,
    phase: phaseHint,
    questionNumber: session.questionNumber,
    errorCycle: session.errorCycleCount,
  });

  // Check rate limits and include suggested interval adjustment in response
  checkRateLimits();
  const suggestedInterval = rateLimiter.callsThisMinute >= rateLimiter.WARN_PER_MINUTE ? 6000 : null;

  try {
    // Build the provider chain: Gemini (with multi-key) → Groq → OpenRouter → OpenAI
    const providers = [
      {
        name: 'gemini',
        available: gemini.isAvailable(),
        call: async () => {
          recordCall('gemini');
          return await gemini.analyzeFrame(prompt, processedImage, 15000);
        },
      },
      {
        name: 'groq',
        available: groq.isAvailable(),
        call: async () => await groq.analyzeFrame(prompt, processedImage, 20000),
      },
      {
        name: 'openrouter',
        available: openrouter.isAvailable(),
        call: async () => await openrouter.analyzeFrame(prompt, processedImage, 25000),
      },
      {
        name: 'openai',
        available: openai.isAvailable(),
        call: async () => await openai.analyzeFrame(prompt, processedImage, session.conversationHistory, 25000),
      },
    ];

    let result = null;
    let usedProvider = 'none';

    for (const provider of providers) {
      if (!provider.available) continue;

      try {
        logger.info('Trying provider', { provider: provider.name, sessionId });
        result = await provider.call();
        usedProvider = provider.name;

        // If we got a parse error, try next provider
        if (result._parseError && providers.indexOf(provider) < providers.length - 1) {
          logger.warn('Provider returned garbage, trying next', { provider: provider.name });
          continue;
        }

        break; // Success — stop trying
      } catch (err) {
        const isRateLimit = err.message && (err.message.includes('429') || err.message.includes('quota'));
        logger.warn('Provider failed', {
          provider: provider.name,
          error: err.message.substring(0, 150),
          isRateLimit,
        });
        continue; // Try next provider
      }
    }

    if (!result) {
      return {
        phase: 'idle',
        extractedText: 'All AI providers unavailable',
        solution: null,
        error: null,
        _modelUsed: 'none',
        _error: 'All AI providers failed. Retrying on next frame.',
      };
    }

    result._modelUsed = usedProvider;

    if (suggestedInterval) {
      result._suggestedInterval = suggestedInterval;
    }

    // Update conversation history
    sessionStore.addToHistory(sessionId, {
      role: 'user',
      content: `Frame ${session.totalFramesSent}: [image analyzed] Q${session.questionNumber} phase=${phaseHint}`,
    });
    sessionStore.addToHistory(sessionId, {
      role: 'assistant',
      content: JSON.stringify({
        phase: result.phase,
        problemTitle: result.problemTitle,
        hasSolution: !!result.solution,
        hasError: !!result.error,
        provider: usedProvider,
      }),
    });

    sessionStore.updateSession(sessionId, {
      previousFrameText: result.extractedText || '',
      lastModelUsed: usedProvider,
    });

    return result;
  } catch (err) {
    logger.error('Orchestrator unexpected error', { error: err.message });
    return {
      phase: 'idle',
      extractedText: 'AI temporarily unavailable',
      solution: null,
      error: null,
      _modelUsed: 'none',
      _error: err.message,
    };
  }
}

/**
 * Get current rate limiting stats.
 * @returns {Object} Rate limiter state
 */
function getRateLimitStats() {
  checkRateLimits();
  return {
    geminiCallsThisMinute: rateLimiter.callsThisMinute,
    geminiCallsToday: rateLimiter.callsToday,
    geminiMinuteLimit: rateLimiter.MAX_PER_MINUTE,
    geminiDailyLimit: rateLimiter.MAX_PER_DAY,
    geminiAvailable: gemini.isAvailable(),
    openaiAvailable: openai.isAvailable(),
  };
}

/**
 * Extract constraints section from problem text.
 * @param {string} text - Full problem context
 * @returns {string} Extracted constraints or empty string
 */
function extractConstraints(text) {
  if (!text) return '';
  const patterns = [
    /constraints?[:\s]*\n?([\s\S]*?)(?=\n\s*(?:example|input|output|note|$))/i,
    /(\d+\s*[<≤≥>]=?\s*\w+[\s\S]*?(?=\n\n|example|$))/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return '';
}

/**
 * Extract examples section from problem text.
 * @param {string} text - Full problem context
 * @returns {string} Extracted examples or empty string
 */
function extractExamples(text) {
  if (!text) return '';
  const patterns = [
    /examples?[:\s]*\n?([\s\S]*?)(?=\n\s*(?:constraints?|note|$))/i,
    /(input[:\s]*[\s\S]*?output[:\s]*[\s\S]*?)(?=\n\n|constraint|$)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return '';
}

module.exports = { analyzeFrame, getRateLimitStats, selectModel };
