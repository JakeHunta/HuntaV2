require('dotenv').config();

const cfg = {
  port: parseInt(process.env.PORT || '4000', 10),
  env: process.env.NODE_ENV || 'development',
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    embeddingsModel: process.env.EMBEDDINGS_MODEL || 'text-embedding-3-small',
    llmModel: process.env.LLM_MODEL || 'gpt-4o-mini'
  },
  scrapingBee: {
    apiKey: process.env.SCRAPINGBEE_API_KEY,
    premium: /^true$/i.test(process.env.SCRAPINGBEE_PREMIUM || 'true'),
    country: process.env.SCRAPINGBEE_COUNTRY || 'gb',
  },
  sources: {
    facebook: /^true$/i.test(process.env.FACEBOOK_ENABLED || 'true'),
    vinted: /^true$/i.test(process.env.VINTED_ENABLED || 'true'),
    depop: /^true$/i.test(process.env.DEPOP_ENABLED || 'true'),
    discogs: /^true$/i.test(process.env.DISCOGS_ENABLED || 'true'),
    googleShopping: /^true$/i.test(process.env.GOOGLE_SHOPPING_ENABLED || 'true'),
    googleResults: /^true$/i.test(process.env.GOOGLE_RESULTS_ENABLED || 'true')
  },
  cacheTTL: parseInt(process.env.CACHE_TTL_SECONDS || '300', 10),
  rerankTopN: parseInt(process.env.RERANK_TOP_N || '40', 10),
  maxConcurrency: parseInt(process.env.MAX_CONCURRENCY || '4', 10),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '45000', 10)
};

module.exports = cfg;
