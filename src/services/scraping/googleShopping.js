const { fetch, load, normalizeItem } = require('./baseScraper');
const { parsePriceGBP } = require('../../utils/price');

module.exports = {
  source: 'googleShopping',
  search: async ({ query, maxPages = 1 }) => {
    const out = [];
    for (let p = 1; p <= maxPages; p++) {
      const url = `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(query)}&uule=w+CAIQICINVW5pdGVkIEtpbmdkb20`;
      const { data: html } = await fetch(url, { params: { render_js: true, premium_proxy: true } });
      const $ = load(html);
      $('a[href^="/shopping/product/"]').each((_, a) => {
        const link = 'https://www.google.com' + (a.attribs.href || '');
        const card = $(a).closest('div');
        const title = $(a).text();
        const priceText = card.find('span:contains(£)').first().text();
        const image = card.find('img').attr('src');
        out.push(normalizeItem({ source: 'googleShopping', title, link, image, price: parsePriceGBP(priceText) }));
      });
    }
    return out;
  }
};
