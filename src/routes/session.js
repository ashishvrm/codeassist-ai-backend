/**
 * Session management routes.
 * @module routes/session
 */

const express = require('express');
const router = express.Router();
const sessionStore = require('../state/session');
const logger = require('../utils/logger');

/**
 * POST /api/session/start
 * Creates a new session.
 * Body: { language?: string }
 * Returns: { sessionId, language }
 */
router.post('/start', (req, res) => {
  try {
    const { language } = req.body || {};
    const session = sessionStore.createSession(language);
    res.json({
      sessionId: session.id,
      language: session.language,
    });
  } catch (err) {
    logger.error('Failed to create session', { error: err.message });
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * POST /api/session/:id/end
 * Ends a session and returns summary statistics.
 * Returns: { totalQuestions, totalErrors, duration, totalFramesSent, totalApiCalls }
 */
router.post('/:id/end', (req, res) => {
  try {
    const summary = sessionStore.endSession(req.params.id);
    if (!summary) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(summary);
  } catch (err) {
    logger.error('Failed to end session', { error: err.message, sessionId: req.params.id });
    res.status(500).json({ error: 'Failed to end session' });
  }
});

/**
 * GET /api/session/:id/status
 * Returns current session state for debugging.
 */
router.get('/:id/status', (req, res) => {
  try {
    const session = sessionStore.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({
      id: session.id,
      createdAt: session.createdAt,
      language: session.language,
      currentPhase: session.currentPhase,
      questionNumber: session.questionNumber,
      errorCount: session.errorCount,
      errorCycleCount: session.errorCycleCount,
      totalFramesSent: session.totalFramesSent,
      totalApiCalls: session.totalApiCalls,
      currentProblemTitle: session.currentProblemTitle,
      lastModelUsed: session.lastModelUsed,
      conversationHistoryLength: session.conversationHistory.length,
    });
  } catch (err) {
    logger.error('Failed to get session status', { error: err.message });
    res.status(500).json({ error: 'Failed to get session status' });
  }
});

module.exports = router;
