const { fetch, load, normalizeItem } = require('./baseScraper');
const { parsePriceGBP } = require('../../utils/price');

module.exports = {
  source: 'discogs',
  search: async ({ query, maxPages = 1 }) => {
    const out = [];
    for (let p = 1; p <= maxPages; p++) {
      const url = `https://www.discogs.com/sell/list?format=all&currency=GBP&q=${encodeURIComponent(query)}&page=${p}`;
      const { data: html } = await fetch(url, { params: { render_js: false } });
      const $ = load(html);
      $('table#pjax_container tbody tr').each((_, tr) => {
        const title = $(tr).find('td.item_description a.item_description_title').text();
        const link = 'https://www.discogs.com' + ($(tr).find('td.item_description a').attr('href') || '');
        const priceText = $(tr).find('td.price').text();
        const condition = $(tr).find('td.condition').text();
        const image = $(tr).find('td.image img').attr('data-src') || $(tr).find('td.image img').attr('src');
        if (!title || !link) return;
        out.push(normalizeItem({ source: 'discogs', title, link, image, price: parsePriceGBP(priceText), condition }));
      });
    }
    return out;
  }
};
