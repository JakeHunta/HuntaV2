// src/services/searchService.js
import pLimit from 'p-limit';
import { openaiService } from './openaiService.js';
import { scrapingService } from './scrapingService.js';
import { logger } from '../utils/logger.js';

/* ---------- config ---------- */
const STRICT_MODE_DEFAULT = true;       // enforce must-have tokens
const MAX_TERMS = 4;                    // fewer expansions = less drift
const MAX_RESULTS = 40;

/* ---------- weights ---------- */
const SOURCE_WEIGHTS = {
  ebay: 1.0,
  gumtree: 0.9,
  cashConverters: 0.85,
  facebook: 0.75,
  vinted: 0.75,
  depop: 0.75,
  discogs: 0.8,
  googleShopping: 0.6,
  googleResults: 0.6,
};

/* ---------- string utils ---------- */
function normalizeText(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function parsePriceNumber(str) {
  if (typeof str === 'number') return str;
  if (!str) return null;
  const m = String(str).replace(/,/g, '').match(/(-?\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}
function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
}
function priceClosenessScore(amount, med) {
  if (!amount || !med) return 0.5;
  const diffPct = Math.abs(amount - med) / (med + 1e-6);
  return Math.max(0, 1 - Math.min(1, diffPct));
}
function recencyScore(iso) {
  if (!iso) return 0.5;
  const ts = Date.parse(iso); if (Number.isNaN(ts)) return 0.5;
  const days = (Date.now() - ts) / 86400000;
  if (days <= 1) return 1.0;
  if (days <= 7) return 0.8;
  if (days <= 30) return 0.6;
  if (days <= 90) return 0.4;
  return 0.2;
}
function uniqKey(r) {
  const t = normalizeText(r?.title);
  const p = parsePriceNumber(r?.price);
  const link = r?.link || '';
  let host = '';
  try { host = new URL(link).hostname.replace(/^www\./, ''); } catch {}
  return `${t}::${p ?? 'na'}::${host}`;
}

/* ---------- brand/domain heuristics ---------- */
const STRYMON_MODELS = [
  'ob-1','ob1','compadre','timeline','bigsky','bluesky','blue sky','mobius','el capistan','capistan',
  'deco','flint','lex','ola','brig','riverside','sunset','volante','dig','ojai','zuma',
  'iridium','nightsky','night sky','cloudburst','zelzah','ultraviolet','ultra violet'
].map(normalizeText);

function detectBrand(q) {
  const s = normalizeText(q);
  if (s.includes('strymon')) return 'strymon';
  if (s.includes('pokemon') || s.includes('pokémon')) return 'pokemon';
  return null;
}

function detectTargetModel(q) {
  const s = normalizeText(q);
  if (/ob[-\s]?1\b/.test(s)) return 'ob-1';
  return null;
}

/* ---------- must-have token extraction ---------- */
const COMMON_STOP = new Set(['the','a','an','and','or','with','for','of','to','in','on','card','tcg','pokemon','pokémon','guitar','effects','pedal']);

function mustHaveTokensFromQuery(q) {
  const s = normalizeText(q);
  const tokens = s.split(/[^\w-]+/).filter(Boolean);

  const must = new Set();

  // Keep the most distinctive long token
  const long = tokens.filter(t => t.length >= 4 && !COMMON_STOP.has(t)).sort((a,b)=>b.length-a.length)[0];
  if (long) must.add(long);

  // Hyphenated or model-like tokens: keep collapsed variants too
  tokens.forEach(t => {
    if (/^[a-z0-9]+-[a-z0-9]+$/.test(t)) {
      must.add(t);
      must.add(t.replace('-', ''));   // ob1 alongside ob-1
    }
  });

  // SIR / Special Illustration Rare synonyms
  if (/\bsir\b/i.test(q)) {
    ['sir','special illustration rare','illustration rare','alt art','sar'].forEach(x => must.add(x));
  }

  // If query looks like a Pokémon name (single distinct word), keep it
  // (e.g., "genesect sir" -> "genesect" must appear)
  const first = tokens.find(t => !COMMON_STOP.has(t));
  if (first) must.add(first);

  // Brand/model specifics
  if (detectBrand(q) === 'strymon') must.add('strymon');

  return Array.from(must).map(normalizeText);
}

/* ---------- precision filter ---------- */
function precisionFilter(items, query, enhanced, { strict = true } = {}) {
  const must = mustHaveTokensFromQuery(query);
  const brand = detectBrand(query);
  const targetModel = detectTargetModel(query);
  const exactPhrase = normalizeText(query).replace(/\s+/g, ' ').trim();

  return items.filter(r => {
    const hay = normalizeText(`${r.title} ${r.description || ''}`);

    // Strict: every must-have token (or phrase) must be present
    if (strict) {
      for (const m of must) {
        if (!m) continue;
        if (!hay.includes(m)) return false;
      }
    }

    // Brand/model heuristics: if user asked Strymon OB-1,
    // drop listings that mention other Strymon models but not OB-1.
    if (brand === 'strymon' && targetModel) {
      const hasTarget = hay.includes('ob-1') || hay.includes('ob 1') || hay.includes('ob1');
      const mentionsOtherModel = STRYMON_MODELS
        .filter(m => m !== 'ob-1' && m !== 'ob1' && m !== 'ob 1')
        .some(m => hay.includes(m));
      if (!hasTarget && mentionsOtherModel) return false;
    }

    // Pokémon SIR: if "SIR" in query, require "sir" OR "special illustration rare"/"alt art"/"sar"
    if (/\bsir\b/i.test(query)) {
      const okSIR = hay.includes('sir') || hay.includes('special illustration rare') || hay.includes('illustration rare') || hay.includes('alt art') || /\bsar\b/.test(hay);
      if (!okSIR) return false;
    }

    // Optionally require the exact phrase if it’s reasonably specific (3+ chars)
    if (strict && exactPhrase.length >= 3) {
      // Don’t hard-require full phrase; but prefer titles that contain all key terms
      // (we already enforced tokens above).
    }

    return true;
  });
}

/* ---------- active sources ---------- */
function getActiveSources(requested) {
  const S = scrapingService;
  const maybe = [
    ['ebay',            S.searchEbay.bind(S)],
    ['gumtree',         S.searchGumtree.bind(S)],
    ['cashConverters',  S.searchCashConverters.bind(S)],
    ['facebook',        S.searchFacebookMarketplace.bind(S)],
    ['vinted',          S.searchVinted?.bind(S)],
    ['depop',           S.searchDepop?.bind(S)],
    ['discogs',         S.searchDiscogs?.bind(S)],
    ['googleShopping',  S.searchGoogleShopping?.bind(S)],
    ['googleResults',   S.searchGoogleResults?.bind(S)],
  ].filter(([, fn]) => typeof fn === 'function');

  if (!requested || !Array.isArray(requested) || !requested.length) return maybe;
  const allow = new Set(requested.map(s => s.toLowerCase()));
  return maybe.filter(([k]) => allow.has(k.toLowerCase()));
}

/* ---------- service ---------- */
class SearchService {
  constructor() {
    this.lastEnhancedQuery = null;
    this.maxConcurrency = Number(process.env.MAX_CONCURRENCY || 4);
  }

  async performSearch(searchTerm, location = 'UK', currency = 'GBP', options = {}) {
    const startedAt = Date.now();
    const strict = options.strictMode ?? STRICT_MODE_DEFAULT;

    // 1) Enhance query (but keep expansions small)
    let enhanced;
    try {
      enhanced = await openaiService.enhanceSearchQuery(searchTerm);
    } catch (e) {
      logger.warn(`⚠️ OpenAI enhance failed: ${e?.message || e}`);
      enhanced = openaiService.getFallbackEnhancement(searchTerm);
    }
    this.lastEnhancedQuery = enhanced;

    const expansions = Array.isArray(enhanced?.search_terms) ? enhanced.search_terms : [];
    const terms = [String(searchTerm || '').trim(), ...expansions]
      .filter(Boolean)
      .slice(0, MAX_TERMS);

    // 2) Pick sources & concurrency
    const sources = getActiveSources(options.sources);
    const limit = pLimit(this.maxConcurrency);

    // 3) Fire scrapes (per term x source)
    const jobs = [];
    for (const t of terms) {
      for (const [key, fn] of sources) {
        jobs.push(
          limit(async () => {
            try {
              const out = await fn(t, location, options.maxPages || 1);
              return Array.isArray(out) ? out.map(x => (x?.source ? x : { ...x, source: key })) : [];
            } catch (e) {
              logger.warn(`[${key}] failed for "${t}": ${e?.message || e}`);
              return [];
            }
          })
        );
      }
    }
    const settled = await Promise.all(jobs);
    let all = settled.flat().filter(Boolean);

    if (!all.length) {
      logger.warn('⚠️ No results from any source');
      return [];
    }

    // 4) Deduplicate + compute numeric price
    const seen = new Set();
    const unique = [];
    for (const r of all) {
      if (!r?.title || !r?.link) continue;
      const key = uniqKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ ...r, priceAmount: parsePriceNumber(r.price) });
    }

    // 5) Precision filtering (BIG win for accuracy)
    const filtered = precisionFilter(unique, searchTerm, enhanced, { strict });
    if (!filtered.length) {
      logger.info('ℹ️ All candidates filtered out by precision rules; returning []');
      return [];
    }

    // 6) Ranking
    const med = median(filtered.map(x => x.priceAmount).filter(n => typeof n === 'number' && !Number.isNaN(n)));
    const qTerms = normalizeText(searchTerm).split(' ').filter(Boolean);
    const eTerms = (enhanced?.search_terms || []).map(normalizeText).filter(Boolean);
    const cats = (enhanced?.categories || []).map(normalizeText).filter(Boolean);
    const exactQ = normalizeText(searchTerm);

    const scored = filtered.map((r) => {
      const title = normalizeText(r.title);
      const desc = normalizeText(r.description || '');
      const src = r.source || '';

      // term matches
      let m = 0;
      for (const t of qTerms) { if (t && title.includes(t)) m += 0.30; if (t && desc.includes(t)) m += 0.10; }
      for (const t of eTerms) { if (t && title.includes(t)) m += 0.15; if (t && desc.includes(t)) m += 0.05; }
      for (const c of cats)   { if (c && (title.includes(c) || desc.includes(c))) m += 0.10; }
      if (title.includes(exactQ)) m += 0.20;                       // exact phrase boost
      if ((r.title || '').length < 20) m -= 0.05;
      if (r.image) m += 0.03;

      const priceScore = priceClosenessScore(r.priceAmount, med) * 0.15;
      const recScore   = recencyScore(r.postedAt) * 0.10;
      const srcWeight  = (SOURCE_WEIGHTS[src] ?? 0.6) * 0.05;

      let score = 0.50 * Math.min(1, Math.max(0, m)) + priceScore + recScore + srcWeight;
      score = Math.max(0, Math.min(1, score));
      return { ...r, score: Math.round(score * 100) / 100 };
    });

    const top = scored.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);

    logger.info(`✅ Returning ${top.length} results in ${Date.now() - startedAt}ms (strict=${strict})`);
    return top;
  }

  getLastEnhancedQuery() { return this.lastEnhancedQuery; }
}

export const searchService = new SearchService();

