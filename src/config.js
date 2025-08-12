module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 10000,

  // concurrency & limits
  maxConcurrency: Number(process.env.MAX_CONCURRENCY || 2),
  maxExpansions: Number(process.env.MAX_EXPANSIONS || 4),
  maxRequestsPerSearch: Number(process.env.MAX_REQUESTS_PER_SEARCH || 12),

  // default sources
  sources: {
    ebay: true,
    gumtree: true,
    facebook: true,
    cashConverters: false,
    vinted: false,
    depop: false,
    discogs: false,
    googleShopping: false,
    googleResults: false,
  }
};
