const cheerio = require('cheerio');

function load(html) { return cheerio.load(html, { decodeEntities: true }); }

function text(el) { return (el || '').toString().trim(); }

function safeJsonFromScript(html, pattern) {
  const m = html.match(pattern);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

module.exports = { load, text, safeJsonFromScript };
