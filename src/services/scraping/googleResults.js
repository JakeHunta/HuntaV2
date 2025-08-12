const { fetch, load, normalizeItem } = require('./baseScraper');

function likelyProductResult(title, snippet, url) {
  const t = (title || '').toLowerCase();
  const s = (snippet || '').toLowerCase();
  if (/for sale|buy now|price|£|in stock|add to cart/.test(t + ' ' + s)) return true;
  if (/classifieds|marketplace|shop|store|product|listing|sell|gumtree|facebook|depop|vinted|reverb|discogs/.test(url)) return true;
  return false;
}

module.exports = {
  source: 'googleResults',
  search: async ({ query, maxPages = 1 }) => {
    const out = [];
    for (let p = 0; p < maxPages; p++) {
      const start = p * 10;
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&start=${start}&hl=en-GB&gl=gb`;
      const { data: html } = await fetch(url, { params: { render_js: true, premium_proxy: true } });
      const $ = load(html);
      $('div.g').each((_, el) => {
        const a = $(el).find('a').first();
        const link = a.attr('href');
        const title = $(el).find('h3').text();
        const snippet = $(el).find('div[data-sncf]").text() || $(el).find('.VwiC3b').text();
        if (!link || !title) return;
        if (!likelyProductResult(title, snippet, link)) return;
        out.push(normalizeItem({ source: 'googleResults', title, link, image: null, price: { amount: null, currency: 'GBP' }, description: snippet }));
      });
    }
    return out;
  }
};
