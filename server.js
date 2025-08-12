import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { searchService } from './services/searchService.js';

// Load env first
dotenv.config();

// Quick env check
console.log('🔧 Environment check:');
console.log('- OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? `✅ Loaded (${process.env.OPENAI_API_KEY.slice(0, 8)}...)` : '❌ Missing');
console.log('- SCRAPINGBEE_API_KEY:', process.env.SCRAPINGBEE_API_KEY ? `✅ Loaded (${process.env.SCRAPINGBEE_API_KEY.slice(0, 8)}...)` : '❌ Missing');
console.log('- NODE_ENV:', process.env.NODE_ENV || 'development');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Render proxy (for rate limit / IPs)
app.set('trust proxy', 1);

// Middleware
app.use(helmet());

const allowedOrigin = process.env.FRONTEND_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

app.use(express.json({ limit: '1mb' }));

// Basic global rate limit (adjust if needed)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60, // 60 req/min
    standardHeaders: true,
    legacyHeaders: false
  })
);

// In-memory user stats
const userStats = { totalSearches: 0 };

// Utility logger
const logWithTimestamp = (level, message, data = {}) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`);
  if (data && Object.keys(data).length) console.log('Data:', JSON.stringify(data, null, 2));
};

// Routes
app.get('/', (req, res) => {
  res.json({
    name: 'Hunta Backend API',
    version: '2.0.0',
    status: 'running',
    endpoints: {
      'POST /search': 'Search for second-hand items',
      'GET /health': 'Health check',
      'GET /user-stats': 'User and usage statistics',
      'GET /': 'API information'
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      openai: process.env.OPENAI_API_KEY ? 'configured' : 'missing',
      scrapingbee: process.env.SCRAPINGBEE_API_KEY ? 'configured' : 'missing'
    },
    uptime: Math.floor(process.uptime())
  });
});

app.get('/user-stats', (req, res) => {
  res.json({
    uptimeSeconds: Math.floor(process.uptime()),
    totalSearches: userStats.totalSearches,
    timestamp: new Date().toISOString()
  });
});

// Helpful hint if someone POSTs to /
app.post('/', (req, res) => {
  res.status(400).json({ error: 'Use POST /search instead of POST /' });
});

// Search endpoint
app.post('/search', async (req, res) => {
  const startTime = Date.now();
  try {
    const { search_term, location = 'UK', currency = 'GBP', sources, maxPages } = req.body || {};

    if (!search_term || typeof search_term !== 'string' || !search_term.trim()) {
      logWithTimestamp('warn', 'Invalid search term provided', { search_term });
      return res.status(400).json({
        error: 'Invalid search term',
        message: 'Please provide a non-empty search term as a string',
        timestamp: new Date().toISOString()
      });
    }

    const cleanSearchTerm = search_term.trim();
    const searchLocation = (location || 'UK').trim();
    const searchCurrency = currency || 'GBP';

    logWithTimestamp('info', 'Starting search', {
      searchTerm: cleanSearchTerm,
      location: searchLocation,
      currency: searchCurrency,
      sources,
      maxPages
    });

    userStats.totalSearches++;

    // Pass optional sources/maxPages to the service (safe to omit)
    const items = await searchService.performSearch(
      cleanSearchTerm,
      searchLocation,
      searchCurrency,
      { sources, maxPages }
    );

    const enhancedQuery = searchService.getLastEnhancedQuery();
    const processingTime = Date.now() - startTime;

    logWithTimestamp('info', 'Search completed', {
      resultsCount: items.length,
      processingTimeMs: processingTime
    });

    // Return both keys to avoid breaking any client
    res.json({
      items,
      listings: items,
      enhancedQuery
    });
  } catch (error) {
    const processingTime = Date.now() - startTime;

    console.error('💥 Full search error details:', {
      message: error?.message,
      stack: error?.stack,
      name: error?.name,
      code: error?.code,
      processingTimeMs: processingTime,
      searchTerm: req.body?.search_term
    });

    logWithTimestamp('error', 'Search request failed', {
      message: error?.message,
      stack: error?.stack,
      processingTimeMs: processingTime,
      name: error?.name,
      code: error?.code
    });

    res.status(500).json({
      error: 'Search failed',
      message: error?.message || 'Internal error',
      code: error?.code,
      name: error?.name,
      timestamp: new Date().toISOString(),
      processingTimeMs: processingTime
    });
  }
});

// 404 handler
app.use((req, res) => {
  logWithTimestamp('warn', '404 - Endpoint not found', {
    method: req.method,
    path: req.path,
    ip: req.ip
  });
  res.status(404).json({
    error: 'Endpoint not found',
    message: `${req.method} ${req.path} is not a valid endpoint`,
    availableEndpoints: {
      'POST /search': 'Search for second-hand items',
      'GET /health': 'Health check',
      'GET /user-stats': 'User and usage statistics',
      'GET /': 'API information'
    },
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use((error, req, res, next) => {
  logWithTimestamp('error', 'Unhandled server error', {
    message: error?.message,
    stack: error?.stack,
    name: error?.name,
    code: error?.code,
    method: req.method,
    path: req.path
  });
  res.status(500).json({
    error: 'Internal server error',
    message: 'An unexpected error occurred',
    timestamp: new Date().toISOString()
  });
});

// Hardening for unhandled errors
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED_REJECTION', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT_EXCEPTION', err);
});

app.listen(PORT, () => {
  logWithTimestamp('info', `🎯 Hunta Backend API started successfully on port ${PORT}`);
  console.log(`🔍 POST /search`);
  console.log(`🏥 GET  /health`);
});

export default app;
