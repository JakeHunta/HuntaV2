const crypto = require('crypto');

function hashUrl(url) { return crypto.createHash('sha1').update(url || '').digest('hex'); }

function keyFromTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|for|and|or|with|of|in|on)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = `${hashUrl(it.link)}:${keyFromTitle(it.title)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

module.exports = { dedupe, keyFromTitle, hashUrl };
