/**
 * Frame analysis endpoint — the CORE of CodeAssist AI.
 * Called every ~3 seconds by the mobile app with a camera frame.
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
 * Main frame analysis endpoint.
 * Body: { sessionId: string, frame: string (base64 JPEG), frameHash?: string }
 * Returns: structured response with action, phase, solution/error data
 */
router.post('/', async (req, res) => {
  const startTime = Date.now();

  try {
    const { sessionId, frame, frameHash } = req.body;

    // Validate request
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!frame) {
      return res.status(400).json({ error: 'frame (base64 image) is required' });
    }

    // Validate session
    const session = sessionStore.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found. Start a new session.' });
    }

    // Increment frame counter
    session.totalFramesSent++;
    sessionStore.updateSession(sessionId, { totalFramesSent: session.totalFramesSent });

    // Frame diffing — skip if frame hasn't changed
    let computedHash = frameHash;
    if (!computedHash) {
      try {
        const imageBuffer = Buffer.from(frame, 'base64');
        computedHash = await imageHash.computeHash(imageBuffer);
      } catch (hashErr) {
        logger.warn('Hash computation failed, processing frame anyway', { error: hashErr.message });
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

        logger.debug('Frame skipped (no change)', {
          sessionId,
          similarity: sim.toFixed(3),
          unchangedCount: session.unchangedFrameCount,
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

    // Update hash for next comparison
    sessionStore.updateSession(sessionId, {
      previousFrameHash: computedHash,
      unchangedFrameCount: 0,
    });

    // Send to AI orchestrator
    const aiResponse = await orchestrator.analyzeFrame(sessionId, frame);

    // Process through state machine
    const result = stateMachine.processResponse(sessionId, aiResponse);

    const elapsed = Date.now() - startTime;
    logger.info('Frame analyzed', {
      sessionId,
      elapsed,
      action: result.action,
      phase: result.phase,
      questionNumber: result.questionNumber,
      model: aiResponse._modelUsed,
    });

    res.json(result);
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error('Frame analysis failed', {
      error: err.message,
      stack: err.stack,
      elapsed,
      sessionId: req.body?.sessionId,
    });

    res.status(500).json({
      action: 'monitoring',
      phase: 'idle',
      error: 'Analysis failed: ' + err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

module.exports = router;
