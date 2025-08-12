const { priceBandScore } = require('../utils/price');

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function computeText(item) {
  return [item.title, item.description, item.brand, item.model].filter(Boolean).join(' ');
}

function rank(items, opts) {
  const { queryEmbedding, medianPrice, sourceWeights = {} } = opts;
  return items.map(it => {
    const sim = queryEmbedding ? cosine(it.embedding || queryEmbedding, queryEmbedding) : 0.5;
    const titleHit = titleKeywordHitRate(it, opts.keywords || []);
    const priceScore = priceBandScore(it.price, medianPrice);
    const recency = recencyScore(it.postedAt);
    const sourceW = sourceWeights[it.source] ?? 1;
    const score = 0.50*sim + 0.20*titleHit + 0.15*priceScore + 0.10*recency + 0.05*sourceW;
    return { ...it, score };
  }).sort((a,b) => b.score - a.score);
}

function titleKeywordHitRate(it, keywords) {
  if (!keywords?.length) return 0.5;
  const t = (it.title || '').toLowerCase();
  const hits = keywords.filter(k => t.includes(k.toLowerCase())).length;
  return Math.min(1, hits / Math.max(1, keywords.length));
}

function recencyScore(iso) {
  if (!iso) return 0.5;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 0.5;
  const days = (Date.now() - ts) / (1000*60*60*24);
  if (days <= 1) return 1;
  if (days <= 7) return 0.8;
  if (days <= 30) return 0.6;
  if (days <= 90) return 0.4;
  return 0.2;
}

module.exports = { computeText, rank };
