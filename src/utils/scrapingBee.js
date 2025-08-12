const axios = require('axios');
const pRetry = require('p-retry');
const cfg = require('../config');

const client = axios.create({
  baseURL: 'https://app.scrapingbee.com/api/v1/',
  timeout: cfg.requestTimeoutMs
});

async function fetch(url, options = {}) {
  const params = {
    api_key: cfg.scrapingBee.apiKey,
    url,
    country_code: cfg.scrapingBee.country,
    render_js: true,
    block_resources: true,
    premium_proxy: cfg.scrapingBee.premium,
    ...options.params,
  };

  return pRetry(async () => {
    const res = await client.get('/', { params });
    return { data: res.data, status: res.status, headers: res.headers };
  }, { retries: 2, minTimeout: 400, maxTimeout: 1500 });
}

module.exports = { fetch };
