function normalizeTitle(t) {
  return (t || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function normalizeCurrency(cur) {
  if (!cur) return 'GBP';
  const c = cur.toUpperCase();
  if (['£', 'GBP'].includes(c)) return 'GBP';
  if (['€', 'EUR'].includes(c)) return 'EUR';
  if (['$', 'USD'].includes(c)) return 'USD';
  return c;
}

function parsePostedAt(raw) {
  // Accept ISO or relative text; fallback null
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
  return null;
}

module.exports = { normalizeTitle, normalizeCurrency, parsePostedAt };
