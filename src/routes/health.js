/**
 * Health check endpoint.
 * @module routes/health
 */

const express = require('express');
const router = express.Router();
const orchestrator = require('../services/orchestrator');

/**
 * GET /api/health
 * Returns server health status, uptime, and AI availability.
 */
router.get('/', (req, res) => {
  const stats = orchestrator.getRateLimitStats();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    ai: {
      geminiAvailable: stats.geminiAvailable,
      openaiAvailable: stats.openaiAvailable,
      geminiCallsThisMinute: stats.geminiCallsThisMinute,
      geminiCallsToday: stats.geminiCallsToday,
    },
  });
});

module.exports = router;
