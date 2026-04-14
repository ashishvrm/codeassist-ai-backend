/**
 * Google Gemini Vision API integration.
 * @module gemini
 */

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const logger = require('../utils/logger');

let genAI = null;
let model = null;

/**
 * Initialize the Gemini client. Called lazily on first use.
 */
function init() {
  if (genAI) return;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.includes('__PASTE_')) {
    logger.warn('Gemini API key not configured');
    return;
  }
  genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
    },
  });
  logger.info('Gemini client initialized', { model: process.env.GEMINI_MODEL });
}

/**
 * Check if Gemini is available (API key configured).
 * @returns {boolean}
 */
function isAvailable() {
  init();
  return model !== null;
}

/**
 * Send an image + prompt to Gemini Vision and get a parsed JSON response.
 * Includes retry logic with exponential backoff for rate limiting.
 * @param {string} prompt - Text prompt
 * @param {string} base64Image - Base64-encoded JPEG image
 * @param {number} [timeoutMs=15000] - Request timeout in milliseconds
 * @returns {Promise<Object>} Parsed JSON response from Gemini
 */
async function analyzeFrame(prompt, base64Image, timeoutMs = 15000) {
  init();
  if (!model) {
    throw new Error('Gemini not configured');
  }

  const imagePart = {
    inlineData: {
      data: base64Image,
      mimeType: 'image/jpeg',
    },
  };

  const maxRetries = 3;
  const backoffMs = [1000, 2000, 4000];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const startTime = Date.now();

      const resultPromise = model.generateContent([prompt, imagePart]);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Gemini request timed out')), timeoutMs)
      );

      const result = await Promise.race([resultPromise, timeoutPromise]);
      const response = await result.response;
      const text = response.text();
      const elapsed = Date.now() - startTime;

      logger.info('Gemini response received', { elapsed, textLength: text.length, attempt });

      return parseAIResponse(text);
    } catch (err) {
      const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));
      const isTimeout = err.message && err.message.includes('timed out');

      if (attempt < maxRetries && (isRateLimit || isTimeout)) {
        const delay = backoffMs[attempt] || 4000;
        logger.warn('Gemini retry', { attempt: attempt + 1, reason: isRateLimit ? 'rate_limit' : 'timeout', delay });
        await sleep(delay);
        continue;
      }

      logger.error('Gemini request failed', { error: err.message, attempt });
      throw err;
    }
  }
}

/**
 * Send a text-only prompt to Gemini (no image).
 * @param {string} prompt - Text prompt
 * @param {number} [timeoutMs=15000] - Timeout
 * @returns {Promise<Object>} Parsed JSON response
 */
async function analyzeText(prompt, timeoutMs = 15000) {
  init();
  if (!model) {
    throw new Error('Gemini not configured');
  }

  const startTime = Date.now();
  const resultPromise = model.generateContent([prompt]);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Gemini request timed out')), timeoutMs)
  );

  const result = await Promise.race([resultPromise, timeoutPromise]);
  const response = await result.response;
  const text = response.text();

  logger.info('Gemini text response', { elapsed: Date.now() - startTime, textLength: text.length });
  return parseAIResponse(text);
}

/**
 * Parse AI response text into a JSON object.
 * Handles markdown-wrapped JSON and malformed responses.
 * @param {string} text - Raw response text
 * @returns {Object} Parsed response
 */
function parseAIResponse(text) {
  if (!text || text.trim().length === 0) {
    return { phase: 'idle', extractedText: 'Empty AI response', solution: null, error: null };
  }

  let cleaned = text.trim();

  // Strip markdown code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try to extract JSON object from the text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e2) {
        // Fallback
      }
    }

    logger.warn('Failed to parse AI response as JSON', { textPreview: text.substring(0, 200) });
    return {
      phase: 'idle',
      extractedText: text.substring(0, 1000),
      solution: null,
      error: null,
      _parseError: true,
    };
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { analyzeFrame, analyzeText, isAvailable, parseAIResponse };
