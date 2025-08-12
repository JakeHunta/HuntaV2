const { fetch, load, normalizeItem } = require('./baseScraper');
const { parsePriceGBP } = require('../../utils/price');

module.exports = {
  source: 'gumtree',
  search: async ({ query, maxPages = 1 }) => {
    const out = [];
    for (let p = 1; p <= maxPages; p++) {
      const url = `https://www.gumtree.com/search?search_category=all&q=${encodeURIComponent(query)}&page=${p}`;
      const { data: html } = await fetch(url, {});
      const $ = load(html);
      $('[data-q="search-result"]').each((_, el) => {
        const title = $(el).find('h2 a').text();
        const link = 'https://www.gumtree.com' + ($(el).find('h2 a').attr('href') || '');
        const priceText = $(el).find('[itemprop=price]').text();
        const image = $(el).find('img').attr('src');
        const location = $(el).find('[data-q=locality]').text();
        if (!title || !link) return;
        out.push(normalizeItem({ source: 'gumtree', title, link, image, price: parsePriceGBP(priceText), location }));
      });
    }
    return out;
  }
};
