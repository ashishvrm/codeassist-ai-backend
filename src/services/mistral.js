/**
 * Mistral La Plateforme API integration — free 500K tokens/month with Pixtral vision.
 * Used as the second fallback after Gemini, before OpenRouter.
 * @module mistral
 */

const logger = require('../utils/logger');
const { parseAIResponse } = require('./gemini');

const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

/**
 * Check if Mistral is available.
 * @returns {boolean}
 */
function isAvailable() {
  const key = process.env.MISTRAL_API_KEY;
  return !!(key && !key.includes('__PASTE_'));
}

/**
 * Send an image + prompt to Mistral Pixtral.
 * @param {string} prompt - Text prompt
 * @param {string} base64Image - Base64-encoded JPEG image
 * @param {number} [timeoutMs=22000] - Timeout
 * @returns {Promise<Object>} Parsed JSON response
 */
async function analyzeFrame(prompt, base64Image, timeoutMs = 22000) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey || apiKey.includes('__PASTE_')) {
    throw new Error('Mistral not configured');
  }

  const model = process.env.MISTRAL_MODEL || 'pixtral-12b-2409';

  try {
    const startTime = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${MISTRAL_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
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
                image_url: `data:image/jpeg;base64,${base64Image}`,
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
      throw new Error(`Mistral HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    const elapsed = Date.now() - startTime;

    logger.info('Mistral response received', { elapsed, textLength: text.length, model });

    return parseAIResponse(text);
  } catch (err) {
    logger.error('Mistral request failed', { error: err.message });
    throw err;
  }
}

module.exports = { analyzeFrame, isAvailable };
