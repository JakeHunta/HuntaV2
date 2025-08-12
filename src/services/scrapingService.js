// src/services/scrapingService.js
import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';

class ScrapingService {
  constructor() {
    this.scrapingBeeBaseUrl = 'https://app.scrapingbee.com/api/v1/';
    this.countryCode = 'gb';
  }

  get scrapingBeeApiKey() {
    return process.env.SCRAPINGBEE_API_KEY;
  }

  /**
   * Fetch a page through ScrapingBee and return Cheerio $
   */
  async fetchHTML(
    url,
    {
      render_js = false,
      wait = 0,
      premium_proxy = true,
      block_resources = true,
    } = {}
  ) {
    if (!this.scrapingBeeApiKey) {
      throw new Error('SCRAPINGBEE_API_KEY missing');
    }

    const params = {
      api_key: this.scrapingBeeApiKey,
      url,
      render_js: render_js ? 'true' : 'false',
      premium_proxy: premium_proxy ? 'true' : 'false',
      block_resources: block_resources ? 'true' : 'false',
      country_code: this.countryCode,
    };
    if (wait) params.wait = String(wait);

    logger.info('🐝 ScrapingBee GET', { url, params: { ...params, api_key: '***' } });

    const res = await axios.get(this.scrapingBeeBaseUrl, { params, timeout: 60000 });
    return cheerio.load(res.data);
  }

  // -----------------------------
  // Helpers / Normalization
  // -----------------------------

  // Detect currency from a price string
  detectCurrency(price = '') {
    if (/[£]/.test(price)) return 'GBP';
    if (/[$]/.test(price)) return 'USD';
    if (/[€]/.test(price)) return 'EUR';
    return null;
  }

  // Heuristic: does a text look like "UK"?
  isUKLocation(text = '') {
    return /(united kingdom|^uk$|\buk\b|england|scotland|wales|northern ireland|great britain|\bgb\b)/i.test(
      String(text).trim()
    );
  }

  // Force higher-res eBay thumbnails (e.g. .../s-l64.jpg -> /s-l500.jpg)
  upgradeEbayImage(url = '') {
    if (!url) return url;
    return url.replace(/\/s-l\d+\.jpg(\?.*)?$/i, '/s-l500.jpg');
    // If you want maximum quality, change to s-l1600.jpg
  }

  /**
   * Normalize a listing object to a consistent shape
   */
  normalize({
    title,
    price,
    link,
    image,
    source,
    description = '',
    postedAt = null,
    location = '',
  }) {
    if (!title || !link) return null;

    const cleanedPrice = this.cleanPrice(price || '');
    return {
      title: this.cleanTitle(title),
      price: cleanedPrice,
      currency: this.detectCurrency(cleanedPrice), // NEW
      link,
      image: image || '',
      source,
      description: description || this.cleanTitle(title),
      postedAt,
      location, // NEW
    };
  }

  improveEbayImageUrl(url, $item) {
    if (!url && $item) {
      const srcset = $item.find('.s-item__image img').attr('srcset');
      if (srcset) {
        const candidates = srcset.split(',').map((s) => s.trim().split(' ')[0]);
        const highRes =
          candidates.find((c) => c.includes('_1280.jpg')) ||
          candidates.find((c) => c.includes('_640.jpg')) ||
          candidates.find((c) => c.includes('_500.jpg')) ||
          candidates[candidates.length - 1];
        if (highRes) return highRes;
      }
      const dataSrc = $item.find('.s-item__image img').attr('data-src');
      if (dataSrc) return dataSrc;
      return url;
    }

    const replacements = ['_1280.jpg', '_640.jpg', '_500.jpg'];
    for (const suffix of replacements) {
      const candidate = (url || '').replace(/_(32|64|96|140|180|225)\.jpg$/, suffix);
      if (candidate) return candidate;
    }
    return url;
  }

  // Public helper: filter an array to UK-only results (use in your search service)
  filterUKOnly(items = []) {
    const isUK = (txt = '') => this.isUKLocation(txt);
    return items.filter((it) => {
      // currency must be GBP if present
      if (it.currency && it.currency !== 'GBP') return false;

      // if we have a location string (esp. eBay), enforce it
      if (it.location && !isUK(it.location)) return false;

      // UK-native sources are fine
      if (['gumtree', 'cashConverters'].includes(it.source)) return true;

      // For others (facebook, depop, vinted, etc.), GBP filter above is usually enough
      return true;
    });
  }

  // -----------------------------
  // eBay
  // -----------------------------
  async searchEbay(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`🛒 eBay: "${searchTerm}" (loc=${location})`);
      if (!this.scrapingBeeApiKey) {
        logger.warn('⚠️ ScrapingBee key missing; returning mock eBay data');
        return this.getMockEbayResults(searchTerm);
      }

      const listings = [];
      for (let p = 1; p <= Math.max(1, maxPages); p++) {
        const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(
          searchTerm
        )}&_sop=12&_fsrp=1&LH_PrefLoc=3&_pgn=${p}`;
        const $ = await this.fetchHTML(url, { render_js: false, premium_proxy: true });

        $('.s-item').each((_, el) => {
          const $item = $(el);
          const title = $item.find('.s-item__title').text().trim();
          const price = $item.find('.s-item__price').text().trim();
          const link = $item.find('.s-item__link').attr('href');
          let image = $item.find('.s-item__image img').attr('src');
          image = this.improveEbayImageUrl(image, $item);
          image = this.upgradeEbayImage(image); // NEW: crisper thumbs
          const locationText = $item.find('.s-item__location, .s-item__itemLocation').text().trim(); // NEW

          if (!title || !link || /shop on ebay/i.test(title)) return;
          const norm = this.normalize({
            title,
            price,
            link,
            image,
            source: 'ebay',
            description: title,
            location: locationText, // NEW
          });
          if (norm) listings.push(norm);
        });
      }

      logger.info(`✅ eBay: ${listings.length} items`);
      return listings.slice(0, 60);
    } catch (error) {
      logger.error(`❌ eBay error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  // -----------------------------
  // Gumtree
  // -----------------------------
  async searchGumtree(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`🌳 Gumtree: "${searchTerm}" (loc=${location})`);
      if (!this.scrapingBeeApiKey) {
        logger.warn('⚠️ ScrapingBee key missing; returning mock Gumtree data');
        return this.getMockGumtreeResults(searchTerm);
      }

      const listings = [];
      for (let p = 1; p <= Math.max(1, maxPages); p++) {
        let url = `https://www.gumtree.com/search?search_category=all&q=${encodeURIComponent(
          searchTerm
        )}&page=${p}`;
        if (location && location !== 'UK') url += `&search_location=${encodeURIComponent(location)}`;

        const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true });

        $('[data-q="search-result"], .listing-link, .listing-item, [data-q="listing"]').each((_, el) => {
          const $item = $(el);
          let title = $item.find('h2 a, .listing-title, .listing-item-title, h2, h3').first().text().trim();
          let price = $item
            .find('[itemprop=price], .listing-price, .price, .ad-price, .tilePrice')
            .first()
            .text()
            .trim();
          let link = $item.find('h2 a, a').first().attr('href');
          let image = $item.find('img').first().attr('src') || $item.find('img').first().attr('data-src');
          if (!title) title = $item.find('[data-q="listing-title"], .tileTitle').text().trim();
          if (link && link.startsWith('/')) link = `https://www.gumtree.com${link}`;

          const norm = this.normalize({
            title,
            price,
            link,
            image,
            source: 'gumtree',
            location: 'United Kingdom', // UK site hint
          });
          if (norm) listings.push(norm);
        });
      }
      logger.info(`✅ Gumtree: ${listings.length} items`);
      return listings.slice(0, 60);
    } catch (error) {
      logger.error(`❌ Gumtree error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  // -----------------------------
  // Facebook Marketplace (best effort; dynamic)
  // -----------------------------
  async searchFacebookMarketplace(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`📘 Facebook: "${searchTerm}" (loc=${location})`);
      if (!this.scrapingBeeApiKey) {
        logger.warn('⚠️ ScrapingBee key missing; returning mock Facebook data');
        return this.getMockFacebookResults(searchTerm);
      }

      const listings = [];
      // Marketplace is dynamic; pagination via next pages is unreliable—do 1 page best-effort
      const url = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(
        searchTerm
      )}&exact=false`;
      const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true, wait: 3500 });

      $('a[href*="/marketplace/item/"]').each((_, a) => {
        const linkRaw = a.attribs?.href || '';
        let link = linkRaw.startsWith('/') ? `https://www.facebook.com${linkRaw}` : linkRaw;

        const card = $(a).closest('[role=article], div');
        const title = card.find('span[dir="auto"]').first().text().trim() || $(a).text().trim();
        const price = card
          .find('span')
          .filter((i, el) => /[£$€]\s*\d/.test($(el).text()))
          .first()
          .text()
          .trim();
        const image = card.find('img').attr('src');

        const norm = this.normalize({
          title,
          price,
          link,
          image,
          source: 'facebook',
          // (optional) location: 'United Kingdom'
        });
        if (norm) listings.push(norm);
      });

      logger.info(`✅ Facebook: ${listings.length} items`);
      return listings.slice(0, 40);
    } catch (error) {
      logger.error(`❌ Facebook error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  // -----------------------------
  // CashConverters
  // -----------------------------
  async searchCashConverters(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`💰 CashConverters: "${searchTerm}" (loc=${location})`);
      if (!this.scrapingBeeApiKey) {
        logger.warn('⚠️ ScrapingBee key missing; returning mock CashConverters data');
        return this.getMockCashConvertersResults(searchTerm);
      }

      const listings = [];
      for (let p = 1; p <= Math.max(1, maxPages); p++) {
        const url = `https://www.cashconverters.co.uk/search?q=${encodeURIComponent(searchTerm)}${
          p > 1 ? `&page=${p}` : ''
        }`;
        const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true });

        $('.product-tile, .product').each((_, el) => {
          const $item = $(el);
          const title = $item.find('.product-title, .product-name').text().trim();
          const price = $item.find('.product-price, .price').text().trim();
          let link = $item.find('a').attr('href');
          const image = $item.find('img').attr('src') || $item.find('img').attr('data-src');
          if (link && link.startsWith('/')) link = `https://www.cashconverters.co.uk${link}`;

          const norm = this.normalize({
            title,
            price,
            link,
            image,
            source: 'cashConverters',
            location: 'United Kingdom', // UK site hint
          });
          if (norm) listings.push(norm);
        });
      }

      logger.info(`✅ CashConverters: ${listings.length} items`);
      return listings.slice(0, 60);
    } catch (error) {
      logger.error(`❌ CashConverters error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  // -----------------------------
  // OPTIONAL SOURCES (enable when ready)
  // -----------------------------
  async searchVinted(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`🧥 Vinted: "${searchTerm}"`);
      if (!this.scrapingBeeApiKey) return [];

      const listings = [];
      for (let p = 1; p <= Math.max(1, maxPages); p++) {
        const url = `https://www.vinted.co.uk/catalog?search_text=${encodeURIComponent(
          searchTerm
        )}&page=${p}`;
        const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true });

        // Try to find embedded state
        const html = $.html();
        const m = html.match(/window\.__NUXT__\s*=\s*(\{.*?\});/);
        if (m) {
          try {
            const nuxt = JSON.parse(m[1]);
            const products = nuxt?.state?.products || [];
            for (const prod of products) {
              const norm = this.normalize({
                title: prod.title || prod.name,
                price: String(prod?.price?.amount || prod.price || ''),
                link: prod.url ? `https://www.vinted.co.uk${prod.url}` : null,
                image: prod?.photo?.url || prod?.image,
                source: 'vinted',
                description: prod?.description || '',
              });
              if (norm) listings.push(norm);
            }
            continue;
          } catch {
            // ignore parse errors; fall back to DOM
          }
        }

        // Fallback DOM parse
        $('[data-testid="item-box"]').each((_, el) => {
          const aHref = $(el).find('a').attr('href');
          const link = aHref ? `https://www.vinted.co.uk${aHref}` : null;
          const title = $(el).find('[data-testid="item-title"]').text().trim();
          const price = $(el).find('[data-testid="item-price"]').text().trim();
          const image = $(el).find('img').attr('src');
          const norm = this.normalize({ title, price, link, image, source: 'vinted' });
          if (norm) listings.push(norm);
        });
      }
      logger.info(`✅ Vinted: ${listings.length} items`);
      return listings.slice(0, 60);
    } catch (error) {
      logger.error(`❌ Vinted error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  async searchDepop(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`🧢 Depop: "${searchTerm}"`);
    if (!this.scrapingBeeApiKey) return [];

      const listings = [];
      for (let p = 1; p <= Math.max(1, maxPages); p++) {
        const url = `https://www.depop.com/search/?q=${encodeURIComponent(searchTerm)}&page=${p}`;
        const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true });

        $('a[href^="/products/"]').each((_, a) => {
          const link = `https://www.depop.com${a.attribs?.href || ''}`;
          const card = $(a).parent();
          const title = card.find('p').first().text().trim();
          const price = card
            .find('span')
            .filter((i, el) => /[£$€]\s*\d/.test($(el).text()))
            .first()
            .text()
            .trim();
          const image = card.find('img').attr('src');
          const norm = this.normalize({ title, price, link, image, source: 'd epop' });
          if (norm) listings.push(norm);
        });
      }
      logger.info(`✅ Depop: ${listings.length} items`);
      return listings.slice(0, 60);
    } catch (error) {
      logger.error(`❌ Depop error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  async searchDiscogs(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`💿 Discogs: "${searchTerm}"`);
      if (!this.scrapingBeeApiKey) return [];

      const listings = [];
      for (let p = 1; p <= Math.max(1, maxPages); p++) {
        const url = `https://www.discogs.com/sell/list?format=all&currency=GBP&q=${encodeURIComponent(
          searchTerm
        )}&page=${p}`;
        const $ = await this.fetchHTML(url, { render_js: false, premium_proxy: true });

        $('table#pjax_container tbody tr').each((_, tr) => {
          const title = $(tr).find('td.item_description a.item_description_title').text().trim();
          const link = 'https://www.discogs.com' + ($(tr).find('td.item_description a').attr('href') || '');
          const price = $(tr).find('td.price').text().trim();
          const image =
            $(tr).find('td.image img').attr('data-src') || $(tr).find('td.image img').attr('src');
          const norm = this.normalize({ title, price, link, image, source: 'discogs' });
          if (norm) listings.push(norm);
        });
      }
      logger.info(`✅ Discogs: ${listings.length} items`);
      return listings.slice(0, 60);
    } catch (error) {
      logger.error(`❌ Discogs error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  async searchGoogleShopping(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`🛍️ Google Shopping: "${searchTerm}"`);
      if (!this.scrapingBeeApiKey) return [];

      const listings = [];
      // Google is sensitive; keep pages low
      for (let p = 0; p < Math.min(1, maxPages); p++) {
        const url = `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(
          searchTerm
        )}&hl=en-GB&gl=gb`;
        const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true });

        $('a[href^="/shopping/product/"]').each((_, a) => {
          const link = `https://www.google.com${a.attribs?.href || ''}`;
          const card = $(a).closest('div');
          const title = $(a).text().trim();
          const price = card
            .find('span')
            .filter((i, el) => /[£$€]\s*\d/.test($(el).text()))
            .first()
            .text()
            .trim();
          const image = card.find('img').attr('src');
          const norm = this.normalize({ title, price, link, image, source: 'googleShopping' });
          if (norm) listings.push(norm);
        });
      }
      logger.info(`✅ Google Shopping: ${listings.length} items`);
      return listings.slice(0, 40);
    } catch (error) {
      logger.error(`❌ Google Shopping error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  async searchGoogleResults(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`🔎 Google Results: "${searchTerm}"`);
      if (!this.scrapingBeeApiKey) return [];

      const listings = [];
      for (let p = 0; p < Math.max(1, maxPages); p++) {
        const start = p * 10;
        const url = `https://www.google.com/search?q=${encodeURIComponent(
          searchTerm
        )}&num=10&start=${start}&hl=en-GB&gl=gb`;
        const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true });

        $('div.g').each((_, el) => {
          const a = $(el).find('a').first();
          const link = a.attr('href');
          const title = $(el).find('h3').first().text().trim();
          const snippet =
            $(el).find('div[data-sncf]').text().trim() ||
            $(el).find('.VwiC3b').text().trim() ||
            $(el).find('.aCOpRe').text().trim() ||
            '';

          if (!link || !title) return;

          // Simple heuristic to keep likely product/listing pages
          const hay = `${title} ${snippet}`.toLowerCase();
          if (
            !/(for sale|buy now|price|£|\$|€|in stock|add to cart|listing|shop|store|gumtree|ebay|facebook|depop|vinted|discogs|reverb)/.test(
              hay
            )
          ) {
            return;
          }

          const norm = this.normalize({
            title,
            price: '', // price unknown from SERP
            link,
            image: '',
            source: 'googleResults',
            description: snippet,
          });
          if (norm) listings.push(norm);
        });
      }
      logger.info(`✅ Google Results: ${listings.length} items`);
      return listings.slice(0, 40);
    } catch (error) {
      logger.error(`❌ Google Results error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  // -----------------------------
  // Utils
  // -----------------------------
  cleanTitle(title) {
    return String(title || '')
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s\-.,()]/g, '')
      .trim()
      .substring(0, 200);
  }

  cleanPrice(price) {
    if (!price) return '';
    const money = String(price);
    const match = money.match(/[£$€]\s*[\d,]+(?:\.\d{2})?/);
    if (match) return match[0].replace(/\s+/g, '');
    const num = money.match(/[\d,]+(?:\.\d{2})?/);
    if (num) return `£${num[0]}`;
    return money.trim().substring(0, 20);
  }

  _errInfo(error) {
    return {
      message: error?.message,
      status: error?.response?.status,
      statusText: error?.response?.statusText,
      code: error?.code,
      url: error?.config?.url,
    };
  }

  // -----------------------------
  // Mocks (when no ScrapingBee key)
  // -----------------------------
  getMockGumtreeResults(searchTerm) {
    return [
      {
        title: `${searchTerm} - Excellent Condition`,
        price: '£150',
        currency: 'GBP',
        link: 'https://www.gumtree.com/p/mock-listing-1',
        image: 'https://images.pexels.com/photos/1751731/pexels-photo-1751731.jpeg',
        source: 'gumtree',
        description: `Used ${searchTerm} in excellent condition`,
        location: 'United Kingdom',
      },
      {
        title: `${searchTerm} - Good Deal`,
        price: '£120',
        currency: 'GBP',
        link: 'https://www.gumtree.com/p/mock-listing-2',
        image: 'https://images.pexels.com/photos/1751731/pexels-photo-1751731.jpeg',
        source: 'gumtree',
        description: `Second-hand ${searchTerm} at great price`,
        location: 'United Kingdom',
      },
    ];
  }

  getMockEbayResults(searchTerm) {
    return [
      {
        title: `${searchTerm} - eBay Special`,
        price: '£180',
        currency: 'GBP',
        link: 'https://www.ebay.com/itm/mock-listing-1',
        image: 'https://images.pexels.com/photos/1751731/pexels-photo-1751731.jpeg',
        source: 'ebay',
        description: `Pre-owned ${searchTerm} from eBay`,
        location: 'United Kingdom',
      },
    ];
  }

  getMockFacebookResults(searchTerm) {
    return [
      {
        title: `${searchTerm} - Facebook Find`,
        price: '£100',
        currency: 'GBP',
        link: 'https://www.facebook.com/marketplace/item/mock-listing-1',
        image: 'https://images.pexels.com/photos/1751731/pexels-photo-1751731.jpeg',
        source: 'facebook',
        description: `Great ${searchTerm} from Facebook Marketplace`,
        location: 'United Kingdom',
      },
    ];
  }

  getMockCashConvertersResults(searchTerm) {
    return [
      {
        title: `${searchTerm} - CashConverters Mock`,
        price: '£99',
        currency: 'GBP',
        link: 'https://www.cashconverters.co.uk/mock-listing-1',
        image: 'https://images.pexels.com/photos/1751731/pexels-photo-1751731.jpeg',
        source: 'cashConverters',
        description: `Mock listing for ${searchTerm} on CashConverters`,
        location: 'United Kingdom',
      },
    ];
  }
}

export const scrapingService = new ScrapingService();
