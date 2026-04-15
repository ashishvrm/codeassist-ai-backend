/**
 * Google Gemini Vision API integration with multi-key rotation.
 * When one API key hits 429 rate limit, automatically rotates to the next key.
 * Keys are configured via GEMINI_API_KEY (primary) and GEMINI_API_KEYS (comma-separated backups).
 * @module gemini
 */

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const logger = require('../utils/logger');

/** @type {Array<{ key: string, client: GoogleGenerativeAI, model: Object, exhausted: boolean }>} */
let keyPool = [];
let currentKeyIndex = 0;
let initialized = false;

const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const GENERATION_CONFIG = {
  temperature: 0.1,
  maxOutputTokens: 4096,
};

/**
 * Initialize the key pool from environment variables.
 * Supports: GEMINI_API_KEY (single key) and GEMINI_API_KEYS (comma-separated list).
 * All unique keys are pooled together.
 */
function init() {
  if (initialized) return;
  initialized = true;

  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const allKeys = new Set();

  // Primary key
  const primaryKey = process.env.GEMINI_API_KEY;
  if (primaryKey && !primaryKey.includes('__PASTE_')) {
    allKeys.add(primaryKey.trim());
  }

  // Additional keys (comma-separated)
  const extraKeys = process.env.GEMINI_API_KEYS;
  if (extraKeys) {
    extraKeys.split(',').forEach((k) => {
      const trimmed = k.trim();
      if (trimmed && !trimmed.includes('__PASTE_')) {
        allKeys.add(trimmed);
      }
    });
  }

  if (allKeys.size === 0) {
    logger.warn('No Gemini API keys configured');
    return;
  }

  for (const key of allKeys) {
    const client = new GoogleGenerativeAI(key);
    const model = client.getGenerativeModel({
      model: modelName,
      safetySettings: SAFETY_SETTINGS,
      generationConfig: GENERATION_CONFIG,
    });
    keyPool.push({
      key: key.substring(0, 8) + '...',  // Masked for logging
      client,
      model,
      exhausted: false,
    });
  }

  logger.info('Gemini key pool initialized', {
    model: modelName,
    keyCount: keyPool.length,
    keys: keyPool.map((k) => k.key),
  });
}

/**
 * Get the current active model, rotating past exhausted keys.
 * @returns {Object|null} { model, keyInfo } or null if all exhausted
 */
function getActiveModel() {
  if (keyPool.length === 0) return null;

  // Try each key starting from current index
  for (let i = 0; i < keyPool.length; i++) {
    const idx = (currentKeyIndex + i) % keyPool.length;
    if (!keyPool[idx].exhausted) {
      currentKeyIndex = idx;
      return { model: keyPool[idx].model, keyInfo: keyPool[idx].key, keyIndex: idx };
    }
  }

  // All keys exhausted — reset and try the first one (maybe quota reset)
  logger.warn('All Gemini API keys exhausted, resetting pool');
  keyPool.forEach((k) => { k.exhausted = false; });
  currentKeyIndex = 0;
  return { model: keyPool[0].model, keyInfo: keyPool[0].key, keyIndex: 0 };
}

/**
 * Mark current key as exhausted (429'd) and rotate to the next one.
 * @param {number} keyIndex - Index of the exhausted key
 */
function markKeyExhausted(keyIndex) {
  if (keyIndex >= 0 && keyIndex < keyPool.length) {
    keyPool[keyIndex].exhausted = true;
    const remaining = keyPool.filter((k) => !k.exhausted).length;
    logger.warn('API key exhausted, rotating', {
      exhaustedKey: keyPool[keyIndex].key,
      remainingKeys: remaining,
      totalKeys: keyPool.length,
    });
    // Move to next key
    currentKeyIndex = (keyIndex + 1) % keyPool.length;
  }
}

/**
 * Check if Gemini is available (at least one key configured).
 * @returns {boolean}
 */
function isAvailable() {
  init();
  return keyPool.length > 0;
}

/**
 * Send an image + prompt to Gemini Vision with auto key rotation on 429.
 * @param {string} prompt - Text prompt
 * @param {string} base64Image - Base64-encoded JPEG image
 * @param {number} [timeoutMs=15000] - Request timeout
 * @returns {Promise<Object>} Parsed JSON response
 */
async function analyzeFrame(prompt, base64Image, timeoutMs = 15000) {
  init();
  if (keyPool.length === 0) {
    throw new Error('Gemini not configured');
  }

  const imagePart = {
    inlineData: {
      data: base64Image,
      mimeType: 'image/jpeg',
    },
  };

  // Try each key in the pool
  let lastError = null;
  for (let attempt = 0; attempt < keyPool.length; attempt++) {
    const active = getActiveModel();
    if (!active) {
      throw lastError || new Error('All Gemini API keys exhausted');
    }

    try {
      const startTime = Date.now();

      const resultPromise = active.model.generateContent([prompt, imagePart]);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Gemini request timed out')), timeoutMs)
      );

      const result = await Promise.race([resultPromise, timeoutPromise]);
      const response = await result.response;
      const text = response.text();
      const elapsed = Date.now() - startTime;

      logger.info('Gemini response received', {
        elapsed,
        textLength: text.length,
        key: active.keyInfo,
      });

      return parseAIResponse(text);
    } catch (err) {
      const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));

      if (isRateLimit) {
        markKeyExhausted(active.keyIndex);
        lastError = err;
        continue; // Try next key immediately
      }

      // Non-rate-limit error — don't rotate, just throw
      logger.error('Gemini request failed', { error: err.message, key: active.keyInfo });
      throw err;
    }
  }

  // All keys failed
  throw lastError || new Error('All Gemini API keys rate limited');
}

/**
 * Send a text-only prompt to Gemini (no image).
 * @param {string} prompt - Text prompt
 * @param {number} [timeoutMs=15000] - Timeout
 * @returns {Promise<Object>} Parsed JSON response
 */
async function analyzeText(prompt, timeoutMs = 15000) {
  init();
  const active = getActiveModel();
  if (!active) {
    throw new Error('Gemini not configured');
  }

  const startTime = Date.now();
  const resultPromise = active.model.generateContent([prompt]);
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
 * @param {string} text - Raw response text
 * @returns {Object} Parsed response
 */
function parseAIResponse(text) {
  if (!text || text.trim().length === 0) {
    return { phase: 'idle', extractedText: 'Empty AI response', solution: null, error: null };
  }

  let cleaned = text.trim();

  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    return JSON.parse(cleaned);
  } catch (e) {
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
 * Get key pool status for health endpoint.
 * @returns {Object}
 */
function getKeyPoolStatus() {
  return {
    totalKeys: keyPool.length,
    activeKeys: keyPool.filter((k) => !k.exhausted).length,
    currentKeyIndex,
    keys: keyPool.map((k) => ({ key: k.key, exhausted: k.exhausted })),
  };
}

module.exports = { analyzeFrame, analyzeText, isAvailable, parseAIResponse, getKeyPoolStatus };
