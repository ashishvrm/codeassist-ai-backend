/**
 * OpenAI GPT-4o integration with vision capabilities.
 * Used as fallback for hard problems and error recovery.
 * @module openai
 */

const OpenAI = require('openai');
const logger = require('../utils/logger');
const { parseAIResponse } = require('./gemini');

let client = null;

/**
 * Initialize the OpenAI client. Called lazily on first use.
 */
function init() {
  if (client) return;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.includes('__PASTE_')) {
    logger.warn('OpenAI API key not configured — GPT fallback unavailable');
    return;
  }
  client = new OpenAI({ apiKey });
  logger.info('OpenAI client initialized', { model: process.env.OPENAI_MODEL });
}

/**
 * Check if OpenAI is available (API key configured).
 * @returns {boolean}
 */
function isAvailable() {
  init();
  return client !== null;
}

/**
 * Send an image + prompt to GPT-4o Vision and get a parsed JSON response.
 * @param {string} prompt - Text prompt
 * @param {string} base64Image - Base64-encoded JPEG image
 * @param {Array<Object>} [conversationHistory=[]] - Previous messages for context
 * @param {number} [timeoutMs=25000] - Request timeout
 * @returns {Promise<Object>} Parsed JSON response
 */
async function analyzeFrame(prompt, base64Image, conversationHistory = [], timeoutMs = 25000) {
  init();
  if (!client) {
    throw new Error('OpenAI not configured');
  }

  const messages = [];

  // Include recent conversation history for context (last 6 messages)
  const recentHistory = conversationHistory.slice(-6);
  for (const entry of recentHistory) {
    messages.push({
      role: entry.role,
      content: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
    });
  }

  // Add the current frame with image
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      {
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${base64Image}`,
          detail: 'high',
        },
      },
    ],
  });

  const maxRetries = 3;
  const backoffMs = [1000, 2000, 4000];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const startTime = Date.now();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await client.chat.completions.create(
        {
          model: process.env.OPENAI_MODEL || 'gpt-4o',
          messages,
          temperature: 0.1,
          max_tokens: 4096,
          response_format: { type: 'json_object' },
        },
        { signal: controller.signal }
      );

      clearTimeout(timeoutId);
      const elapsed = Date.now() - startTime;
      const text = response.choices[0]?.message?.content || '';

      logger.info('OpenAI response received', {
        elapsed,
        textLength: text.length,
        attempt,
        usage: response.usage,
      });

      return parseAIResponse(text);
    } catch (err) {
      const isRateLimit = err.status === 429;
      const isTimeout = err.name === 'AbortError' || (err.message && err.message.includes('timeout'));

      if (attempt < maxRetries && (isRateLimit || isTimeout)) {
        const delay = backoffMs[attempt] || 4000;
        logger.warn('OpenAI retry', { attempt: attempt + 1, reason: isRateLimit ? 'rate_limit' : 'timeout', delay });
        await sleep(delay);
        continue;
      }

      logger.error('OpenAI request failed', { error: err.message, attempt });
      throw err;
    }
  }
}

/**
 * Send a text-only prompt to GPT-4o (no image).
 * @param {string} prompt - Text prompt
 * @param {number} [timeoutMs=25000] - Timeout
 * @returns {Promise<Object>} Parsed JSON response
 */
async function analyzeText(prompt, timeoutMs = 25000) {
  init();
  if (!client) {
    throw new Error('OpenAI not configured');
  }

  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const response = await client.chat.completions.create(
    {
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    },
    { signal: controller.signal }
  );

  clearTimeout(timeoutId);
  const text = response.choices[0]?.message?.content || '';

  logger.info('OpenAI text response', { elapsed: Date.now() - startTime, textLength: text.length });
  return parseAIResponse(text);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { analyzeFrame, analyzeText, isAvailable };
