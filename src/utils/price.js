// src/utils/price.js
function parsePriceGBP(str) {
  if (typeof str === 'number') return { amount: str, currency: 'GBP' };
  if (!str) return { amount: null, currency: 'GBP' };
  const m = String(str).replace(',', '').match(/(£|GBP)?\s*(\d+(?:\.\d{1,2})?)/i);
  if (!m) return { amount: null, currency: 'GBP' };
  const amount = parseFloat(m[2]);
  return { amount, currency: 'GBP' };
}

function priceBandScore(price, median) {
  if (!price?.amount || !median) return 0.5;
  const diff = Math.abs(price.amount - median);
  const pct = diff / (median + 1e-6);
  return Math.max(0, 1 - Math.min(1, pct));
}

module.exports = { parsePriceGBP, priceBandScore };
