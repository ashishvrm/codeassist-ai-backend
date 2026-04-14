/**
 * In-memory session store for CodeAssist AI.
 * Each session tracks conversation history, current phase, question context, etc.
 * @module sessionStore
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

/** @type {Map<string, Object>} */
const sessions = new Map();

/**
 * Create a new session.
 * @param {string} language - Preferred programming language
 * @returns {Object} The newly created session object
 */
function createSession(language) {
  const id = uuidv4();
  const session = {
    id,
    createdAt: new Date().toISOString(),
    language: language || process.env.PREFERRED_LANGUAGE || 'python',
    currentPhase: 'idle',
    questionNumber: 0,
    conversationHistory: [],
    previousFrameText: '',
    previousFrameHash: null,
    questionTexts: [],
    solutions: [],
    errorCount: 0,
    errorCycleCount: 0,
    lastModelUsed: null,
    unchangedFrameCount: 0,
    totalFramesSent: 0,
    totalApiCalls: 0,
    currentProblemTitle: '',
    currentProblemContext: '',
    lastSolutionCode: '',
  };
  sessions.set(id, session);
  logger.info('Session created', { sessionId: id, language: session.language });
  return session;
}

/**
 * Retrieve a session by ID.
 * @param {string} id - Session UUID
 * @returns {Object|null} Session object or null if not found
 */
function getSession(id) {
  return sessions.get(id) || null;
}

/**
 * Update fields on an existing session.
 * @param {string} id - Session UUID
 * @param {Object} updates - Fields to merge
 * @returns {Object|null} Updated session or null
 */
function updateSession(id, updates) {
  const session = sessions.get(id);
  if (!session) return null;
  Object.assign(session, updates);
  return session;
}

/**
 * Add a message to the session's conversation history.
 * Prunes history if it exceeds MAX_CONTEXT_MESSAGES.
 * @param {string} id - Session UUID
 * @param {Object} message - { role, content }
 */
function addToHistory(id, message) {
  const session = sessions.get(id);
  if (!session) return;
  const maxMessages = parseInt(process.env.MAX_CONTEXT_MESSAGES, 10) || 20;
  session.conversationHistory.push(message);
  if (session.conversationHistory.length > maxMessages) {
    session.conversationHistory = session.conversationHistory.slice(-maxMessages);
  }
}

/**
 * End a session and return summary stats.
 * @param {string} id - Session UUID
 * @returns {Object|null} Summary or null
 */
function endSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  const duration = Date.now() - new Date(session.createdAt).getTime();
  const summary = {
    totalQuestions: session.questionNumber,
    totalErrors: session.errorCount,
    duration: Math.round(duration / 1000),
    totalFramesSent: session.totalFramesSent,
    totalApiCalls: session.totalApiCalls,
  };
  sessions.delete(id);
  logger.info('Session ended', { sessionId: id, ...summary });
  return summary;
}

/**
 * Get all active session IDs (for debugging).
 * @returns {string[]}
 */
function getActiveSessions() {
  return Array.from(sessions.keys());
}

module.exports = {
  createSession,
  getSession,
  updateSession,
  addToHistory,
  endSession,
  getActiveSessions,
};
