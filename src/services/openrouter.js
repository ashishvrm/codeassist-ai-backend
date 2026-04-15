/**
 * OpenRouter API integration — aggregator with free vision models.
 * Used as final fallback when Gemini and Groq are exhausted.
 * @module openrouter
 */

const logger = require('../utils/logger');
const { parseAIResponse } = require('./gemini');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Check if OpenRouter is available.
 * @returns {boolean}
 */
function isAvailable() {
  const key = process.env.OPENROUTER_API_KEY;
  return !!(key && !key.includes('__PASTE_'));
}

/**
 * Send an image + prompt to OpenRouter with a free vision model.
 * @param {string} prompt - Text prompt
 * @param {string} base64Image - Base64-encoded JPEG image
 * @param {number} [timeoutMs=25000] - Timeout
 * @returns {Promise<Object>} Parsed JSON response
 */
async function analyzeFrame(prompt, base64Image, timeoutMs = 25000) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes('__PASTE_')) {
    throw new Error('OpenRouter not configured');
  }

  // Free vision models on OpenRouter — try in order of quality
  const model = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free';

  try {
    const startTime = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://codeassist-ai.onrender.com',
        'X-Title': 'CodeAssist AI',
      },
      body: JSON.stringify({
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
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`OpenRouter HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    const elapsed = Date.now() - startTime;

    logger.info('OpenRouter response received', { elapsed, textLength: text.length, model });

    return parseAIResponse(text);
  } catch (err) {
    logger.error('OpenRouter request failed', { error: err.message });
    throw err;
  }
}

module.exports = { analyzeFrame, isAvailable };
