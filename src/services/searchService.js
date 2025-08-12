// src/services/searchService.js  (ESM)
import pLimit from 'p-limit';
import { openaiService } from './openaiService.js';
import { scrapingService } from './scrapingService.js';
import { logger } from '../utils/logger.js';

/* ---------- helpers ---------- */
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

/* ---------- active sources from scrapingService ---------- */
function getActiveSources(requested) {
  // Bind methods to preserve `this` inside ScrapingService class methods
  const S = scrapingService;
  const maybe = [
    ['ebay',            S.searchEbay.bind(S)],
    ['gumtree',         S.searchGumtree.bind(S)],
    ['cashConverters',  S.searchCashConverters.bind(S)],
    ['facebook',        S.searchFacebookMarketplace.bind(S)],
    // Enable only if implemented:
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

    // 1) Enhance query (fallback safely)
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
      .slice(0, 5);

    // 2) Pick sources & concurrency
    const sources = getActiveSources(options.sources);
    const limit = pLimit(this.maxConcurrency);

    // 3) Fire scrapes (per term x source), but never crash on a single failure
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
    const all = settled.flat().filter(Boolean);

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

    // 5) Ranking
    const med = median(unique.map(x => x.priceAmount).filter(n => typeof n === 'number' && !Number.isNaN(n)));
    const qTerms = normalizeText(searchTerm).split(' ').filter(Boolean);
    const eTerms = (enhanced?.search_terms || []).map(normalizeText).filter(Boolean);
    const cats = (enhanced?.categories || []).map(normalizeText).filter(Boolean);

    const scored = unique.map((r) => {
      const title = normalizeText(r.title);
      const desc = normalizeText(r.description || '');
      const src = r.source || '';

      // term matches
      let m = 0;
      for (const t of qTerms) { if (t && title.includes(t)) m += 0.30; if (t && desc.includes(t)) m += 0.10; }
      for (const t of eTerms) { if (t && title.includes(t)) m += 0.20; if (t && desc.includes(t)) m += 0.05; }
      for (const c of cats)   { if (c && (title.includes(c) || desc.includes(c))) m += 0.15; }
      if (title.includes(normalizeText(searchTerm))) m += 0.25;

      // small tweaks
      if ((r.title || '').length < 20) m -= 0.05;
      if (r.image) m += 0.03;

      const priceScore = priceClosenessScore(r.priceAmount, med) * 0.15;
      const recScore   = recencyScore(r.postedAt) * 0.10;
      const srcWeight  = (SOURCE_WEIGHTS[src] ?? 0.6) * 0.05;

      let score = 0.50 * Math.min(1, Math.max(0, m)) + priceScore + recScore + srcWeight;
      score = Math.max(0, Math.min(1, score));
      return { ...r, score: Math.round(score * 100) / 100 };
    });

    const top = scored.sort((a, b) => b.score - a.score).slice(0, 40);

    // 6) (Optional) currency conversion – keep your simple approach here if needed
    // For now, just return as-is in GBP-style strings.
    logger.info(`✅ Returning ${top.length} results in ${Date.now() - startedAt}ms`);
    return top;
  }

  getLastEnhancedQuery() { return this.lastEnhancedQuery; }
}

export const searchService = new SearchService();
