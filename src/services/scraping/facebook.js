const { fetch, load, normalizeItem } = require('./baseScraper');
const { parsePriceGBP } = require('../../utils/price');

module.exports = {
  source: 'facebook',
  search: async ({ query, maxPages = 1 }) => {
    const out = [];
    for (let p = 1; p <= maxPages; p++) {
      const url = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(query)}&exact=false`;
      const { data: html } = await fetch(url, {
        params: { render_js: true, premium_proxy: true, country_code: 'gb' }
      });
      const $ = load(html);
      // Marketplace is dynamic; we attempt to parse card-like anchors
      $('a[href*="/marketplace/item/"]').each((_, a) => {
        const link = 'https://www.facebook.com' + (a.attribs.href || '');
        const card = $(a).closest('[role=article], div');
        const title = card.find('span').first().text() || $(a).text();
        const priceText = card.find('span:contains(£)').first().text();
        const image = card.find('img').attr('src');
        if (!link) return;
        out.push(normalizeItem({ source: 'facebook', title, link, image, price: parsePriceGBP(priceText) }));
      });
    }
    return out;
  }
};
