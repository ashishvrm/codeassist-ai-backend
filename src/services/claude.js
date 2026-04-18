/**
 * Anthropic Claude API integration — primary provider using Sonnet 4.6 vision.
 * Highest-quality code generation; first in the fallback chain.
 * Falls through to Gemini/Mistral/OpenRouter/Groq/OpenAI on error, rate limit,
 * or insufficient credits.
 * @module claude
 */

const logger = require('../utils/logger');
const { parseAIResponse } = require('./gemini');

const CLAUDE_BASE_URL = 'https://api.anthropic.com/v1';
const CLAUDE_API_VERSION = '2023-06-01';

/**
 * Check if Claude is available.
 * @returns {boolean}
 */
function isAvailable() {
  const key = process.env.ANTHROPIC_API_KEY;
  return !!(key && !key.includes('__PASTE_'));
}

/**
 * Send an image + prompt to Claude for vision analysis.
 * @param {string} prompt - Text prompt
 * @param {string} base64Image - Base64-encoded JPEG image
 * @param {number} [timeoutMs=30000] - Timeout
 * @returns {Promise<Object>} Parsed JSON response
 */
async function analyzeFrame(prompt, base64Image, timeoutMs = 30000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.includes('__PASTE_')) {
    throw new Error('Claude not configured');
  }

  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${CLAUDE_BASE_URL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': CLAUDE_API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: base64Image,
                },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Claude HTTP ${response.status}: ${errText.substring(0, 300)}`);
    }

    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    const text = textBlock?.text || '';
    const elapsed = Date.now() - startTime;

    logger.info('Claude response received', {
      elapsed,
      textLength: text.length,
      model,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
      stopReason: data.stop_reason,
    });

    return parseAIResponse(text);
  } catch (err) {
    logger.error('Claude request failed', { error: err.message });
    throw err;
  }
}

module.exports = { analyzeFrame, isAvailable };
