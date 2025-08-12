const { fetch } = require('../../utils/scrapingBee');
const { load } = require('../../utils/html');
const { parsePriceGBP } = require('../../utils/price');
const { normalizeTitle } = require('../../utils/normalize');

function normalizeItem(partial) {
  return {
    source: partial.source,
    title: normalizeTitle(partial.title),
    price: partial.price ?? parsePriceGBP(partial.priceText),
    image: partial.image || null,
    link: partial.link,
    location: partial.location || null,
    condition: partial.condition || null,
    seller: partial.seller || null,
    postedAt: partial.postedAt || null,
    description: partial.description || '',
    shipping: partial.shipping || null,
    raw: partial.raw || null
  };
}

module.exports = { fetch, load, normalizeItem };
