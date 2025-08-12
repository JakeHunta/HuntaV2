import OpenAI from 'openai';
import { logger } from '../utils/logger.js';

const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const hasKey = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
const client = hasKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function stripCodeFences(s = '') {
  let out = s.trim();
  // ```json ... ``` or ``` ... ```
  if (out.startsWith('```')) {
    out = out.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  }
  return out;
}

function tryParseJsonLoose(text = '') {
  // 1) direct attempt
  try { return JSON.parse(text); } catch {}
  // 2) strip code fences and retry
  const noFences = stripCodeFences(text);
  try { return JSON.parse(noFences); } catch {}
  // 3) extract the first {...} block heuristically
  const first = noFences.indexOf('{');
  const last = noFences.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const maybe = noFences.slice(first, last + 1);
    try { return JSON.parse(maybe); } catch {}
  }
  return null;
}

const systemPrompt = `You are Hunta, an AI assistant that helps users find second-hand products across marketplaces (eBay, Gumtree, etc.).
Given a user's search term, return JSON ONLY in this format:

{
  "original": "user input here",
  "search_terms": ["term1","term2","term3","term4"],
  "categories": ["category1","category2"],
  "forums": ["forum1","forum2"],
  "flags": {
    "high_value_item": true/false,
    "common_scam_target": true/false,
    "likely_on_forums": true/false,
    "reseller_friendly": true/false
  }
}

Guidelines:
- Prefer seller language (brand, model, abbreviations, common misspellings).
- Include condition words where helpful (used, pre-owned).
- Keep arrays concise and relevant (max ~8 search_terms).`;

export const openaiService = {
  /**
   * Enhance a search query via OpenAI. Falls back automatically on any error.
   */
  async enhanceSearchQuery(searchTerm) {
    if (!hasKey) {
      logger.info('🔄 OpenAI key missing — using fallback enhancement');
      return this.getFallbackEnhancement(searchTerm);
    }

    try {
      logger.info(`🤖 Enhancing query via ${MODEL}: "${searchTerm}"`);
      const res = await client.chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Enhance this search query: "${searchTerm}"` }
        ]
      });

      const content = res?.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('Empty completion content');

      const parsed = tryParseJsonLoose(content);
      if (!parsed) throw new Error('Failed to parse JSON from completion');

      // Normalize/validate
      const out = {
        original: parsed.original || String(searchTerm || ''),
        search_terms: Array.isArray(parsed.search_terms) ? parsed.search_terms.filter(Boolean).slice(0, 8) : [],
        categories: Array.isArray(parsed.categories) ? parsed.categories.filter(Boolean) : [],
        forums: Array.isArray(parsed.forums) ? parsed.forums.filter(Boolean) : [],
        flags: {
          high_value_item: !!parsed?.flags?.high_value_item,
          common_scam_target: !!parsed?.flags?.common_scam_target,
          likely_on_forums: !!parsed?.flags?.likely_on_forums,
          reseller_friendly: !!parsed?.flags?.reseller_friendly
        }
      };

      // Ensure at least a couple of terms come back
      if (!out.search_terms.length) {
        logger.warn('⚠️ OpenAI returned no search_terms — falling back merge');
        const fb = this.getFallbackEnhancement(searchTerm);
        out.search_terms = [...new Set([...(fb.search_terms || []), ...(out.search_terms || [])])].slice(0, 8);
        if (!out.categories.length) out.categories = fb.categories || [];
        if (!out.forums.length) out.forums = fb.forums || [];
        out.flags = { ...fb.flags, ...out.flags };
      }

      logger.info(`✅ OpenAI enhanced: ${out.search_terms.length} terms`);
      return out;
    } catch (err) {
      logger.error('❌ OpenAI enhancement error', {
        message: err?.message,
        name: err?.name,
        code: err?.code
      });
      return this.getFallbackEnhancement(searchTerm);
    }
  },

  /**
   * Deterministic fallback expansion without OpenAI.
   */
  getFallbackEnhancement(searchTerm) {
    logger.info('🔄 Using fallback query enhancement');
    const t = String(searchTerm || '').trim();
    const lower = t.toLowerCase();

    const base = [
      t,
      `used ${t}`,
      `${t} second hand`,
      `${t} pre-owned`,
      `${t} secondhand`,
    ];

    // Light domain knowledge
    if (/(iphone|apple)/i.test(lower)) base.push(`${t} unlocked`, `${t} refurbished`);
    if (/(guitar|bass|amp|pedal|synth)/i.test(lower)) base.push(`${t} vintage`, `${t} electric`);
    if (/(car|vehicle)/i.test(lower)) base.push(`${t} low mileage`, `${t} service history`);

    const unique = [...new Set(base)].filter(Boolean).slice(0, 6);

    return {
      original: t,
      search_terms: unique,
      categories: ['general'],
      forums: ['reddit'],
      flags: {
        high_value_item: /(iphone|macbook|rolex|gpu|ps5)/i.test(lower),
        common_scam_target: /(iphone|designer|luxury|gpu)/i.test(lower),
        likely_on_forums: /(guitar|vintage|collectible|pokemon|tcg)/i.test(lower),
        reseller_friendly: true
      }
    };
  }
};
