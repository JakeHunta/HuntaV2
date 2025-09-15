// src/services/searchService.js
import pLimit from 'p-limit';
import { openaiService } from './openaiService.js';
import { scrapingService } from './scrapingService.js';
import { logger } from '../utils/logger.js';

/* ---------- config ---------- */
const STRICT_MODE_DEFAULT = true;     // start strict, then relax, then none
const MAX_TERMS = 3;
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

/* ---------- string & scoring utils ---------- */
const N = (s = '') => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

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

// Accept link or url
function uniqKey(r) {
  const t = normalizeText(r?.title);
  const p = parsePriceNumber(r?.price);
  const href = r?.link || r?.url || '';
  let host = '';
  try { host = new URL(href).hostname.replace(/^www\./, ''); } catch {}
  return `${t}::${p ?? 'na'}::${host}`;
}

/* ---------- UK region filter ---------- */
const UK_HOST_WHITELIST = new Set([
  'ebay.co.uk',
  'm.ebay.co.uk',
  'gumtree.com',
  'cashconverters.co.uk',
  'vinted.co.uk',
  'preloved.co.uk',
  'onbuy.com',
  'facebook.com',
  'm.facebook.com',
  'l.facebook.com',
  'discogs.com',
  'google.com',
]);

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
const hasGBP = (price) => /(^|[^A-Za-z])£\s*\d/.test(String(price || '')) || /\bGBP\b/i.test(String(price || ''));
const hasUSD = (price) => /\$\s*\d/.test(String(price || '')) || /\bUSD\b/i.test(String(price || ''));
const hasEUR = (price) => /€\s*\d/.test(String(price || '')) || /\bEUR\b/i.test(String(price || ''));

function isUKHost(host) {
  return host.endsWith('.co.uk') || host.endsWith('.uk') || UK_HOST_WHITELIST.has(host);
}

/**
 * UK-only preference with clear rules. If the filter empties the list,
 * we still return [] (you asked for UK only behaviour).
 */
function regionFilter(list, { location = 'UK', ukOnly = false } = {}) {
  const wantUK = ukOnly || String(location || '').toUpperCase() === 'UK';
  if (!wantUK) return list;

  const kept = [];
  for (const r of list) {
    const href = r.link || r.url || '';
    const host = hostnameOf(href);
    const gbp = hasGBP(r.price);
    const usd = hasUSD(r.price);
    const eur = hasEUR(r.price);
    const ukHost = isUKHost(host);

    // Facebook: ScrapingBee geo=gb, keep
    if (host.endsWith('facebook.com')) { kept.push(r); continue; }

    // UK host and not obviously $/€
    if (ukHost && !(usd || eur)) { kept.push(r); continue; }

    // Discogs/Google: only keep if GBP visible
    if ((host === 'discogs.com' || host === 'google.com') && gbp) { kept.push(r); continue; }

    // Generic: if no UK host signal, require GBP price
    if (gbp && !usd && !eur) { kept.push(r); continue; }
  }
  return kept;
}

/* ---------- precision / relevance ---------- */
const COMMON_STOP = new Set([
  'the','a','an','and','or','with','for','of','to','in','i','on',
  'card','tcg','pokemon','pokémon','guitar','effects','pedal','amp','amps'
]);

function extractCoreTokens(query) {
  const raw = N(query)
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9.\-\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const scored = raw.map(t => {
    let score = 0;
    if (/\d/.test(t)) score += 2;
    if (/[.-]/.test(t)) score += 1;
    if (t.length >= 4 && !COMMON_STOP.has(t)) score += 1;
    if (/^[a-z]+[0-9]+[a-z0-9]*$/i.test(t)) score += 1;
    return { t, score };
  });

  const seen = new Set();
  const uniq = scored.filter(x => (seen.has(x.t) ? false : (seen.add(x.t), true)));
  uniq.sort((a,b) => (b.score - a.score) || (b.t.length - a.t.length));

  return uniq
    .filter(x => x.t && !COMMON_STOP.has(x.t))
    .slice(0, 3)
    .map(x => x.t);
}

function tokenRegexes(tok) {
  const safe = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flex = safe.replace(/[-.]/g, '[-. ]?');
  const joined = safe.replace(/[-. ]/g, '');
  const arr = [
    new RegExp(`\\b${flex}\\b`, 'i'),
    new RegExp(`\\b${joined}\\b`, 'i')
  ];
  if (!/[-.\s]/.test(tok)) arr.push(new RegExp(`\\b${safe}\\b`, 'i'));
  const seen = new Set();
  return arr.filter(r => (seen.has(String(r)) ? false : (seen.add(String(r)), true)));
}

const EXCLUDE_PATTERNS = [
  /\b(manual|instructions?|book(let)?|guide)\b/i,
  /\b(box\s*only|case\s*only|empty\s*box)\b/i,
  /\bposter|print|sticker|decal|skin(s)?\b/i,
  /\bparts?\s*only|spares?\s*or\s*repairs?\b/i,
  /\bclip\s*art|ai\s*image|wallpaper\b/i
];

function shouldExclude(title, desc) {
  const hay = `${title} ${desc}`.toLowerCase();
  return EXCLUDE_PATTERNS.some(re => re.test(hay));
}

const STRYMON_MODELS = [
  'ob-1','ob1','ob 1',
  'compadre','timeline','bigsky','bluesky','blue sky','mobius','el capistan','capistan',
  'deco','flint','lex','ola','brig','riverside','sunset','volante','dig','ojai','zuma',
  'iridium','nightsky','night sky','cloudburst','zelzah','ultraviolet','ultra violet'
].map(N);

function detectBrand(q) {
  const s = N(q);
  if (s.includes('strymon')) return 'strymon';
  if (/\bpok[eé]mon\b/.test(s)) return 'pokemon';
  return null;
}
function detectTargetModel(q) {
  const s = N(q);
  if (/\bob[-.\s]?1\b/.test(s)) return 'ob-1';
  return null;
}

function precisionFilter(results, query, enhanced = null, opts = {}) {
  const strict = opts.strict ?? true;
  const core = extractCoreTokens(query);

  const extras = Array.isArray(enhanced?.search_terms)
    ? enhanced.search_terms
        .map(N)
        .filter(t => t && !t.includes(' ') && t.length >= 3 && !COMMON_STOP.has(t))
        .slice(0, 3)
    : [];

  const toks = Array.from(new Set([...core, ...extras]));
  if (!toks.length) return results;

  const regsPerTok = toks.map(tokenRegexes);
  // require 2 core hits max, but cap by number of tokens available
  const minHitsTitle   = opts.minHitsTitle   ?? Math.min(2, regsPerTok.length);
  const minHitsRelaxed = opts.minHitsRelaxed ?? Math.min(2, regsPerTok.length);

  const brand = detectBrand(query);
  const targetModel = detectTargetModel(query);
  const wantsSIR = /\bsir\b/i.test(query);

  const out = [];
  for (const r of results) {
    const title = N(r.title || '');
    const desc  = N(r.description || '');
    if (!title) continue;
    if (shouldExclude(title, desc)) continue;

    let hitsTitle = 0, hitsRelaxed = 0;
    regsPerTok.forEach(regs => {
      if (regs.some(re => re.test(title))) hitsTitle += 1;
      else if (regs.some(re => re.test(`${title} ${desc}`))) hitsRelaxed += 1;
    });

    if (strict) {
      if (hitsTitle < minHitsTitle) continue;
    } else {
      const total = hitsTitle + hitsRelaxed;
      if (!(hitsTitle >= Math.max(1, minHitsRelaxed - 1) || total >= minHitsRelaxed)) continue;
    }

    if (brand === 'strymon' && targetModel) {
      const hay = `${title} ${desc}`;
      const hasTarget = /\bob[-.\s]?1\b/.test(hay);
      const mentionsOther = STRYMON_MODELS
        .filter(m => !/\bob[ .-]?1\b/.test(m))
        .some(m => hay.includes(m));
      if (!hasTarget && mentionsOther) continue;
    }

    if (wantsSIR) {
      const hay = `${title} ${desc}`;
      const okSIR = /\bsir\b/.test(hay)
        || /special illustration rare/.test(hay)
        || /illustration rare/.test(hay)
        || /\balt\s*art\b/.test(hay)
        || /\bsar\b/.test(hay);
      if (!okSIR) continue;
    }

    out.push(r);
  }

  return out;
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

/* ---------- country code mapping for ScrapingBee ---------- */
function toCountryCode(location = '') {
  const s = N(location);
  if (['uk','gb','united kingdom','great britain','england','scotland','wales','northern ireland'].includes(s)) return 'gb';
  if (['us','usa','united states','america'].includes(s)) return 'us';
  if (['ie','ireland','eire'].includes(s)) return 'ie';
  return 'gb';
}

/* ---------- service ---------- */
class SearchService {
  constructor() {
    this.lastEnhancedQuery = null;
    this.maxConcurrency = Number(process.env.MAX_CONCURRENCY || 4);
  }

  async performSearch(searchTerm, location = 'UK', currency = 'GBP', options = {}) {
    const startedAt = Date.now();
    const strictRequested = options.strictMode ?? STRICT_MODE_DEFAULT;

    // align ScrapingBee region
    try {
      scrapingService.countryCode = toCountryCode(location);
    } catch (e) {
      logger.warn(`⚠️ Failed to set scraping region: ${e?.message || e}`);
    }

    // 1) Enhance query
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

    // 3) Fire scrapes
    const jobs = [];
    for (const t of terms) {
      for (const [key, fn] of sources) {
        jobs.push(
          limit(async () => {
            try {
              const out = await fn(t, location, options.maxPages || 1);
              return Array.isArray(out)
                ? out.filter(Boolean).map(x => {
                    const link = x?.link || x?.url || '';
                    const url  = x?.url  || x?.link || '';
                    return { ...x, source: x?.source || key, link, url };
                  })
                : [];
            } catch (e) {
              logger.warn(`[${key}] failed for "${t}": ${e?.message || e}`);
              return [];
            }
          })
        );
      }
    }

    // NOTE: using allSettled prevents one source from killing all
    const settled = await Promise.allSettled(jobs);
    let all = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && Array.isArray(s.value)) all.push(...s.value);
    }

    logger.info(`🔎 Aggregated raw items: ${all.length}`);

    if (!all.length) {
      logger.warn('⚠️ No results from any source');
      return [];
    }

    // 4) Deduplicate + compute numeric price
    const seen = new Set();
    const unique = [];
    for (const r of all) {
      if (!r?.title) continue;
      const href = r?.link || r?.url;
      if (!href) continue;
      const key = uniqKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ ...r, priceAmount: parsePriceNumber(r.price) });
    }
    logger.info(`🧹 After dedupe: ${unique.length}`);

    // 5) Region filter (UK-only as requested)
    const regioned = regionFilter(unique, { location, ukOnly: options.ukOnly === true });
    logger.info(`🏳️ After UK filter: ${regioned.length}`);
    if (!regioned.length) {
      logger.info('ℹ️ Region filter removed all items; returning [].');
      return [];
    }

    // 6) Precision filtering
    let filtered = precisionFilter(regioned, searchTerm, enhanced, { strict: strictRequested });
    let mode = strictRequested ? 'strict' : 'relaxed';

    if (!filtered.length && strictRequested) {
      const relaxed = precisionFilter(regioned, searchTerm, enhanced, { strict: false });
      if (relaxed.length) {
        filtered = relaxed;
        mode = 'relaxed';
      } else {
        filtered = regioned; // show something
        mode = 'none';
      }
    }
    logger.info(`🎯 After precision (${mode}): ${filtered.length}`);
    if (!filtered.length) return [];

    // 7) Ranking
    const med = median(filtered.map(x => x.priceAmount).filter(n => typeof n === 'number' && !Number.isNaN(n)));
    const qTerms = normalizeText(searchTerm).split(' ').filter(Boolean);
    const eTerms = (enhanced?.search_terms || []).map(normalizeText).filter(Boolean);
    const cats = (enhanced?.categories || []).map(normalizeText).filter(Boolean);
    const exactQ = normalizeText(searchTerm);

    const scored = filtered.map((r) => {
      const title = normalizeText(r.title);
      const desc = normalizeText(r.description || '');
      const src = r.source || '';

      let m = 0;
      for (const t of qTerms) { if (t && title.includes(t)) m += 0.30; if (t && desc.includes(t)) m += 0.10; }
      for (const t of eTerms) { if (t && title.includes(t)) m += 0.15; if (t && desc.includes(t)) m += 0.05; }
      for (const c of cats)   { if (c && (title.includes(c) || desc.includes(c))) m += 0.10; }
      if (title.includes(exactQ)) m += 0.20;
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

    logger.info(`✅ Returning ${top.length} results in ${Date.now() - startedAt}ms (precision=${mode}, location=${location})`);
    return top;
  }

  getLastEnhancedQuery() { return this.lastEnhancedQuery; }
}

export const searchService = new SearchService();

