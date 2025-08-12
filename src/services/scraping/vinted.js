const { fetch, load, normalizeItem } = require('./baseScraper');
const { parsePriceGBP } = require('../../utils/price');

module.exports = {
  source: 'vinted',
  search: async ({ query, maxPages = 1 }) => {
    const out = [];
    for (let p = 1; p <= maxPages; p++) {
      const url = `https://www.vinted.co.uk/catalog?search_text=${encodeURIComponent(query)}&page=${p}`;
      const { data: html } = await fetch(url, { params: { render_js: true } });
      // Try embedded Nuxt state first
      const m = html.match(/window\.__NUXT__=(\{.*?\});/);
      if (m) {
        try {
          const nuxt = JSON.parse(m[1]);
          const products = nuxt?.state?.products || [];
          for (const p of products) {
            out.push(normalizeItem({
              source: 'vinted',
              title: p.title || p.name,
              link: `https://www.vinted.co.uk${p.url || p.path}`,
              image: p.photo?.url || p.image,
              price: parsePriceGBP(p.price?.amount || p.price),
              location: p.city || null,
              description: p.description || ''
            }));
          }
          continue;
        } catch { /* fallback to DOM */ }
      }
      const $ = load(html);
      $('[data-testid="item-box"]').each((_, el) => {
        const a = $(el).find('a').attr('href');
        const link = a ? `https://www.vinted.co.uk${a}` : null;
        const title = $(el).find('[data-testid="item-title"]').text();
        const priceText = $(el).find('[data-testid="item-price"]').text();
        const image = $(el).find('img').attr('src');
        if (!link) return;
        out.push(normalizeItem({ source: 'vinted', title, link, image, price: parsePriceGBP(priceText) }));
      });
    }
    return out;
  }
};
