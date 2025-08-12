// server.js / index.js
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const app = express();

// Allow your deployed frontend(s)
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// sensible defaults for dev/prod if env not set
if (ALLOWED_ORIGINS.length === 0) {
  ALLOWED_ORIGINS.push('http://localhost:5173', 'https://hunta.uk', 'https://www.hunta.uk');
}

const corsOptions = {
  origin(origin, cb) {
    // allow non-browser tools (no Origin) and allowed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false, // keep false unless you actually need cookies
};

app.use(helmet({
  // Don’t let COEP/CORP get in the way of cross-origin fetches
  crossOriginResourcePolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // handle preflight globally

app.use(express.json({ limit: '1mb' }));

// ... your routes
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// start server as before
