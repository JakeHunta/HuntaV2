const pLimit = require('p-limit');
const cfg = require('../config');
const { expandQuery, embed } = require('./openaiService');
const { rank, computeText } = require('./rankingService');
const { dedupe } = require('../utils/dedupe');

const ebay = require('./scraping/ebay');
const gumtree = require('./scraping/gumtree');
const facebook = require('./scraping/facebook');
const vinted = require('./scraping/vinted');
const depop = require('./scraping/depop');
const discogs = require('./scraping/discogs');
const googleShopping = require('./scraping/googleShopping');
const googleResults = require('./scraping/googleResults');

const registry = {
  ebay, gumtree,
  facebook: cfg.sources.facebook && facebook,
  vinted: cfg.sources.vinted && vinted,
  depop: cfg.sources.depop && depop,
  discogs: cfg.sources.discogs && discogs,
  googleShopping: cfg.sources.googleShopping && googleShopping,
  googleResults: cfg.sources.googleResults && googleResults,
};

function getSources(requested) {
  const all = Object.values(registry).filter(Boolean);
  if (!requested || !requested.length) return all;
  const map = Object.fromEntries(all.map(s => [s.source, s]));
  return requested.map(s => map[s]).filter(Boolean);
}

async function search(params) {
  const { search_term, sources, maxPages = 1 } = params;
  const expansion = await expandQuery(search_term);
  const generatedQueries = expansion.expansions?.length ? expansion.expansions : [search_term];

  // Embed canonical text once
  const canonicalText = [expansion?.canonical?.brand, expansion?.canonical?.model, expansion?.canonical?.variant].filter(Boolean).join(' ');
  const qEmbedding = await embed(canonicalText || search_term);

  const limit = pLimit(cfg.maxConcurrency);
  const scrapers = getSources(sources);

  const results = [];
  await Promise.all(scrapers.map(scraper => limit(async () => {
    for (const q of generatedQueries) {
      try {
        const items = await scraper.search({ query: q, maxPages });
        for (const it of items) {
          results.push({ ...it });
        }
      } catch (e) {
        // swallow per-source errors; could log
        // console.error(`[${scraper.source}]`, e.message);
      }
    }
  })));

  // Deduplicate first
  let deduped = dedupe(results);

  // Attach embeddings (cheap path: reuse query embedding)
  deduped = deduped.map(it => ({ ...it, embedding: qEmbedding }));

  // Median price per set (rough)
  const prices = deduped.map(x => x.price?.amount).filter(x => typeof x === 'number').sort((a,b) => a-b);
  const median = prices.length ? prices[Math.floor(prices.length/2)] : null;

  const ranked = rank(deduped, {
    queryEmbedding: qEmbedding,
    medianPrice: median,
    keywords: (expansion.aliases || []).concat(expansion.canonical?.model || [])
  });

  return {
    query: search_term,
    expansion,
    counts: {
      total: results.length,
      deduped: deduped.length
    },
    items: ranked
  };
}

module.exports = { search };
