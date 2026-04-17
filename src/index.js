/**
 * CodeAssist AI Backend — Express server entry point.
 * @module index
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const os = require('os');

const healthRouter = require('./routes/health');
const sessionRouter = require('./routes/session');
const analyzeRouter = require('./routes/analyze');
const logger = require('./utils/logger');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Middleware
app.use(cors());
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/api/health', healthRouter);
app.use('/api/session', sessionRouter);
app.use('/api/analyze', analyzeRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * Get the local network IP address for mobile app configuration.
 * @returns {string} Local IP address
 */
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// Start server
const server = app.listen(PORT, HOST, () => {
  const localIP = getLocalIP();
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║          CodeAssist AI Backend                   ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}                 ║`);
  console.log(`║  Network: http://${localIP}:${PORT}          ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Set your mobile app BACKEND_URL to:             ║');
  console.log(`║  http://${localIP}:${PORT}                       ║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
  logger.info('Server started', { host: HOST, port: PORT, localIP });

  // Pre-warm AI connections — initializes clients and validates keys on startup
  // so the first real request is fast (no cold-start delay)
  setTimeout(() => {
    try {
      const gemini = require('./services/gemini');
      const mistral = require('./services/mistral');
      const groq = require('./services/groq');
      const openrouter = require('./services/openrouter');
      gemini.isAvailable();
      mistral.isAvailable();
      groq.isAvailable();
      openrouter.isAvailable();
      logger.info('AI providers pre-warmed');
    } catch (e) {
      logger.warn('Pre-warm failed (non-critical)', { error: e.message });
    }
  }, 500);
});

// Graceful shutdown
function gracefulShutdown(signal) {
  logger.info('Shutdown signal received', { signal });
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

module.exports = app;
