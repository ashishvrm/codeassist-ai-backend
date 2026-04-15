/**
 * Groq API integration with Llama 4 Scout vision model.
 * Used as fallback when all Gemini keys are exhausted.
 * @module groq
 */

const Groq = require('groq-sdk');
const logger = require('../utils/logger');
const { parseAIResponse } = require('./gemini');

let client = null;

/**
 * Initialize the Groq client.
 */
function init() {
  if (client) return;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey.includes('__PASTE_')) {
    logger.warn('Groq API key not configured');
    return;
  }
  client = new Groq({ apiKey });
  logger.info('Groq client initialized', { model: process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct' });
}

/**
 * Check if Groq is available.
 * @returns {boolean}
 */
function isAvailable() {
  init();
  return client !== null;
}

/**
 * Send an image + prompt to Groq Vision.
 * @param {string} prompt - Text prompt
 * @param {string} base64Image - Base64-encoded JPEG image
 * @param {number} [timeoutMs=20000] - Timeout
 * @returns {Promise<Object>} Parsed JSON response
 */
async function analyzeFrame(prompt, base64Image, timeoutMs = 20000) {
  init();
  if (!client) {
    throw new Error('Groq not configured');
  }

  const model = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

  try {
    const startTime = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await client.chat.completions.create(
      {
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        temperature: 0.1,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      },
      { signal: controller.signal }
    );

    clearTimeout(timeoutId);
    const text = response.choices[0]?.message?.content || '';
    const elapsed = Date.now() - startTime;

    logger.info('Groq response received', { elapsed, textLength: text.length, model });

    return parseAIResponse(text);
  } catch (err) {
    logger.error('Groq request failed', { error: err.message });
    throw err;
  }
}

module.exports = { analyzeFrame, isAvailable };
