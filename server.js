// backend/server.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { searchService } from './src/services/searchService.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
app.set('trust proxy', 1);

/* ---------- CORS FIRST ---------- */
const ALLOWED = [
  'https://hunta.uk',
  /^https:\/\/[a-z0-9-]+\.netlify\.app$/i, // Netlify previews/branches
  /^http:\/\/localhost:(5173|3000)$/i,
];
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/postman/no-origin
    const ok = ALLOWED.some((rule) =>
      typeof rule === 'string' ? rule === origin : rule.test(origin)
    );
    return cb(ok ? null : new Error(`CORS blocked for ${origin}`), ok);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: false,      // keep false since we allow multiple origins
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // preflight

/* ---------- Helmet (API-safe) ---------- */
app.disable('x-powered-by');
app.use(
  helmet({
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false, // API returns JSON only
  })
);

/* ---------- Standard middleware ---------- */
app.use(express.json({ limit: '1mb' }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/* ---------- tiny logger ---------- */
const log = (level, msg, data) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${level.toUpperCase()}: ${msg}`);
  if (data) console.log('Data:', JSON.stringify(data, null, 2));
};

/* ---------- health ---------- */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    services: {
      openai: !!process.env.OPENAI_API_KEY,
      scrapingbee: !!process.env.SCRAPINGBEE_API_KEY,
    },
    ts: new Date().toISOString(),
  });
});

/* ---------- user stats (optional) ---------- */
const userStats = { totalSearches: 0 };
app.get('/user-stats', (_req, res) => {
  res.json({
    uptimeSeconds: Math.floor(process.uptime()),
    totalSearches: userStats.totalSearches,
    ts: new Date().toISOString(),
  });
});

/* ---------- search ---------- */
app.post('/search', async (req, res) => {
  const start = Date.now();
  try {
    const { search_term, location = 'UK', currency = 'GBP', sources, maxPages, ukOnly } = req.body || {};
    if (!search_term || typeof search_term !== 'string' || !search_term.trim()) {
      return res.status(400).json({ error: 'Invalid search term' });
    }

    const clean = search_term.trim();
    log('info', 'Starting search', {
      origin: req.headers.origin,
      search_term: clean,
      location, currency, sources, maxPages, ukOnly,
    });

    userStats.totalSearches++;
    const items = await searchService.performSearch(clean, location, currency, { sources, maxPages, ukOnly });
    const enhancedQuery = searchService.getLastEnhancedQuery();

    log('info', 'Search completed', {
      resultsCount: items?.length || 0,
      processingTimeMs: Date.now() - start,
    });

    // IMPORTANT: return normalized fields including image/priceLabel/currency
    return res.json({ listings: items, items, enhancedQuery });
  } catch (err) {
    log('error', 'Search failed', {
      message: err?.message,
      stack: err?.stack,
      code: err?.code,
      tookMs: Date.now() - start,
    });
    return res.status(500).json({
      error: 'Search failed',
      message: err?.message || 'Internal error',
    });
  }
});

/* ---------- 404 ---------- */
app.use((req, res) => {
  log('warn', 'Not found', { method: req.method, path: req.path });
  res.status(404).json({ error: 'Endpoint not found' });
});

/* ---------- errors ---------- */
app.use((err, req, res, _next) => {
  log('error', 'Unhandled', {
    message: err?.message,
    stack: err?.stack,
    method: req.method,
    path: req.path,
  });
  res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (r) => console.error('UNHANDLED_REJECTION', r));
process.on('uncaughtException', (e) => console.error('UNCAUGHT_EXCEPTION', e));

app.listen(PORT, () => {
  console.log(`🎯 Hunta Backend API on ${PORT}`);
  console.log('🔍 POST /search');
  console.log('🏥 GET  /health');
});
