const { fetch, load, normalizeItem } = require('./baseScraper');
const { parsePriceGBP } = require('../../utils/price');

module.exports = {
  source: 'ebay',
  search: async ({ query, maxPages = 1 }) => {
    const out = [];
    for (let p = 1; p <= maxPages; p++) {
      const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(query)}&_pgn=${p}`;
      const { data: html } = await fetch(url, { params: { render_js: false } });
      const $ = load(html);
      $('li.s-item').each((_, el) => {
        const title = $(el).find('h3.s-item__title').text();
        const priceText = $(el).find('.s-item__price').text();
        const image = $(el).find('img.s-item__image-img').attr('src');
        const link = $(el).find('a.s-item__link').attr('href');
        if (!title || !link) return;
        out.push(normalizeItem({
          source: 'ebay',
          title,
          price: parsePriceGBP(priceText),
          image, link,
          location: $(el).find('.s-item__location').text() || null,
          postedAt: null,
          description: '',
        }));
      });
    }
    return out;
  }
};
