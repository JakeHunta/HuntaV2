const { fetch, load, normalizeItem } = require('./baseScraper');
const { parsePriceGBP } = require('../../utils/price');

module.exports = {
  source: 'depop',
  search: async ({ query, maxPages = 1 }) => {
    const out = [];
    for (let p = 1; p <= maxPages; p++) {
      const url = `https://www.depop.com/search/?q=${encodeURIComponent(query)}&page=${p}`;
      const { data: html } = await fetch(url, { params: { render_js: true } });
      const $ = load(html);
      $('a[href^="/products/"]').each((_, a) => {
        const link = 'https://www.depop.com' + (a.attribs.href || '');
        const card = $(a).parent();
        const title = card.find('p').first().text();
        const priceText = card.find('span:contains(£)').first().text();
        const image = card.find('img').attr('src');
        if (!link) return;
        out.push(normalizeItem({ source: 'depop', title, link, image, price: parsePriceGBP(priceText) }));
      });
    }
    return out;
  }
};
