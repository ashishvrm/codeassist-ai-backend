/**
 * Health check endpoint.
 * @module routes/health
 */

const express = require('express');
const router = express.Router();
const orchestrator = require('../services/orchestrator');
const gemini = require('../services/gemini');
const mistral = require('../services/mistral');
const groq = require('../services/groq');
const openrouter = require('../services/openrouter');
const openai = require('../services/openai');
const logger = require('../utils/logger');

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
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash (default)',
    keyPool: gemini.getKeyPoolStatus(),
    ai: {
      geminiAvailable: stats.geminiAvailable,
      mistralAvailable: mistral.isAvailable(),
      openrouterAvailable: openrouter.isAvailable(),
      groqAvailable: groq.isAvailable(),
      openaiAvailable: openai.isAvailable(),
      mistralModel: process.env.MISTRAL_MODEL || 'pixtral-12b-2409 (default)',
      geminiCallsThisMinute: stats.geminiCallsThisMinute,
      geminiCallsToday: stats.geminiCallsToday,
    },
  });
});

/**
 * GET /api/health/mistral
 * Deep-check: actually pings Mistral with a tiny text request to confirm the
 * key is both present and accepted by the API.
 */
router.get('/mistral', async (req, res) => {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey || apiKey.includes('__PASTE_')) {
    return res.status(400).json({
      ok: false,
      stage: 'config',
      reason: 'MISTRAL_API_KEY not set in environment',
    });
  }

  const model = process.env.MISTRAL_MODEL || 'pixtral-12b-2409';
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        temperature: 0,
        max_tokens: 5,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const elapsed = Date.now() - start;
    const bodyText = await response.text();

    if (!response.ok) {
      return res.status(200).json({
        ok: false,
        stage: 'api',
        httpStatus: response.status,
        model,
        elapsedMs: elapsed,
        body: bodyText.substring(0, 300),
      });
    }

    let reply = '';
    try {
      reply = JSON.parse(bodyText).choices?.[0]?.message?.content || '';
    } catch (_) {}

    return res.json({
      ok: true,
      stage: 'api',
      httpStatus: response.status,
      model,
      elapsedMs: elapsed,
      reply: reply.substring(0, 50),
    });
  } catch (err) {
    logger.warn('Mistral health check failed', { error: err.message });
    return res.status(200).json({
      ok: false,
      stage: 'network',
      reason: err.message,
      elapsedMs: Date.now() - start,
    });
  }
});

module.exports = router;
