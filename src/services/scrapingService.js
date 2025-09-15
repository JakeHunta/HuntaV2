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

  /* ---------------------------
   * ScrapingBee fetch helpers
   * --------------------------- */
  async fetchHTML(
    url,
    {
      render_js = false,
      wait = 0,
      premium_proxy = true,
      block_resources = true,
      headers = {},
      timeout = 20000,        // ↓ default down from 60000 to keep end-to-end fast
    } = {}
  ) {
    if (!this.scrapingBeeApiKey) throw new Error('SCRAPINGBEE_API_KEY missing');

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
    const res = await axios.get(this.scrapingBeeBaseUrl, { params, timeout, headers });
    return cheerio.load(res.data);
  }

  async fetchText(
    url,
    { render_js = false, wait = 0, premium_proxy = true, block_resources = true, headers = {}, timeout = 20000 } = {}
  ) {
    if (!this.scrapingBeeApiKey) throw new Error('SCRAPINGBEE_API_KEY missing');

    const params = {
      api_key: this.scrapingBeeApiKey,
      url,
      render_js: render_js ? 'true' : 'false',
      premium_proxy: premium_proxy ? 'true' : 'false',
      block_resources: block_resources ? 'true' : 'false',
      country_code: this.countryCode,
    };
    if (wait) params.wait = String(wait);

    logger.info('🐝 ScrapingBee GET (text)', { url, params: { ...params, api_key: '***' } });
    const res = await axios.get(this.scrapingBeeBaseUrl, { params, timeout, headers });
    return res.data;
  }

  /* ---------------------------
   * Normalization & utils
   * --------------------------- */
  detectCurrency(price = '') {
    if (/[£]/.test(price)) return 'GBP';
    if (/[$]/.test(price)) return 'USD';
    if (/[€]/.test(price)) return 'EUR';
    return null;
  }

  isUKLocation(text = '') {
    return /(united kingdom|^uk$|\buk\b|england|scotland|wales|northern ireland|great britain|\bgb\b)/i.test(
      String(text).trim()
    );
  }

  upgradeEbayImage(url = '') {
    if (!url) return url;
    return url.replace(/\/s-l\d+\.jpg(\?.*)?$/i, '/s-l500.jpg');
  }

  normalize({
    title,
    price,
    link,
    image,
    source,
    description = '',
    postedAt = null,
    location = '',
    currency = null,
  }) {
    if (!title || !link) return null;

    const cleanedPrice = this.cleanPrice(price || '');
    return {
      title: this.cleanTitle(title),
      price: cleanedPrice,
      currency: currency || this.detectCurrency(cleanedPrice),
      link,
      url: link, // expose both for upstream
      image: image || '',
      source,
      description: description || this.cleanTitle(title),
      postedAt,
      location,
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

  filterUKOnly(items = []) {
    const isUK = (txt = '') => this.isUKLocation(txt);
    return items.filter((it) => {
      if (it.currency && it.currency !== 'GBP') return false;
      if (it.location && !isUK(it.location)) return false;
      if (['gumtree', 'cashConverters'].includes(it.source)) return true;
      return true;
    });
  }

  /* ---------------------------
   * eBay (RSS-first + HTML fallback)
   * --------------------------- */
  async searchEbay(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`🛒 eBay: "${searchTerm}" (loc=${location})`);

      // 1) RSS (direct to eBay; fast)
      const rssItems = await this._searchEbayRSS(searchTerm, 1);
      if (rssItems.length) {
        logger.info(`✅ eBay (RSS): ${rssItems.length} items`);
        return rssItems.slice(0, 60);
      }
      logger.warn('eBay RSS returned 0; trying HTML fallback.');

      // 2) HTML fallback via ScrapingBee
      const listings = [];
      for (let p = 1; p <= Math.max(1, maxPages); p++) {
        // Keep query minimal; some flags like LH_PrefLoc can zero results for anon users
        const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(
          searchTerm
        )}&rt=nc&_ipg=60&_pgn=${p}`;

        // pass 1: no-JS (fast)
        let $ = await this.fetchHTML(url, {
          render_js: false,
          premium_proxy: true,
          block_resources: false,
          headers: {
            'Accept-Language': 'en-GB,en;q=0.9',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          },
          timeout: 12000,
        });

        let found = this._collectEbayFromPage($, listings);

        // pass 2: JS (if nothing matched)
        if (found === 0) {
          $ = await this.fetchHTML(url, {
            render_js: true,
            wait: 2500,
            premium_proxy: true,
            block_resources: true,
            headers: {
              'Accept-Language': 'en-GB,en;q=0.9',
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
            },
            timeout: 16000,
          });
          found = this._collectEbayFromPage($, listings);
        }
      }

      logger.info(`✅ eBay (HTML): ${listings.length} items`);
      return listings.slice(0, 60);
    } catch (error) {
      logger.error(`❌ eBay error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  _collectEbayFromPage($, bucket) {
    let found = 0;

    // Primary modern container
    const rows = $('ul.srp-results > li.s-item, li.s-item');
    rows.each((_, el) => {
      const $item = $(el);

      // different title/link spots
      const a =
        $item.find('a.s-item__link').first() ||
        $item.find('[data-testid="item-card-title"] a').first() ||
        $item.find('a[href*="/itm/"]').first();

      const title =
        $item.find('h3.s-item__title').first().text().trim() ||
        $item.find('[data-testid="item-card-title"] a').first().text().trim() ||
        $item.find('h3,h2').first().text().trim();

      const link = a.attr('href');
      const price =
        $item.find('.s-item__price').first().text().trim() ||
        $item.find('[data-testid="item-card-price"]').first().text().trim();

      let image =
        $item.find('img.s-item__image-img').attr('src') ||
        $item.find('img.s-item__image-img').attr('data-src') ||
        $item.find('img').attr('src');

      if (!title || !link) return;

      image = this.improveEbayImageUrl(image, $item);
      image = this.upgradeEbayImage(image);

      const locationText =
        $item.find('.s-item__location, .s-item__itemLocation').text().trim() || 'United Kingdom';

      const norm = this.normalize({
        title,
        price,
        link,
        image,
        source: 'ebay',
        description: title,
        location: locationText,
      });
      if (norm) {
        bucket.push(norm);
        found++;
      }
    });

    return found;
  }

  async _searchEbayRSS(searchTerm, page = 1) {
    try {
      const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(searchTerm)}&_sop=12&_pgn=${page}&_rss=1`;
      const { data } = await axios.get(url, {
        headers: {
          Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        },
        timeout: 10000,
      });

      const $ = cheerio.load(data, { xmlMode: true });
      const items = [];
      $('item').each((_, el) => {
        const $el = $(el);
        const title = $el.find('title').text().trim();
        const link = $el.find('link').text().trim();
        const desc = $el.find('description').text() || '';
        const pubDate = $el.find('pubDate').text().trim();

        const priceMatch = desc.match(/£\s?\d[\d,.]*/i);
        const imgMatch = desc.match(/<img[^>]+src="([^"]+)"/i);
        const image = imgMatch ? imgMatch[1] : '';

        const norm = this.normalize({
          title,
          price: priceMatch ? priceMatch[0].replace(/\s+/g, '') : '',
          link,
          image: this.upgradeEbayImage(image),
          source: 'ebay',
          postedAt: pubDate || null,
          location: 'United Kingdom',
          currency: 'GBP',
        });
        if (norm) items.push(norm);
      });

      return items;
    } catch (e) {
      logger.warn('eBay RSS failed:', { message: e?.message, code: e?.code, status: e?.response?.status });
      return [];
    }
  }

  /* ---------------------------
   * Gumtree
   * --------------------------- */
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

        const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true, timeout: 15000 });

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
            location: 'United Kingdom',
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

  /* ---------------------------
   * Facebook Marketplace
   * --------------------------- */
  async searchFacebookMarketplace(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`📘 Facebook: "${searchTerm}" (loc=${location})`);
      if (!this.scrapingBeeApiKey) {
        logger.warn('⚠️ ScrapingBee key missing; returning mock Facebook data');
        return this.getMockFacebookResults(searchTerm);
      }

      const listings = [];
      const url = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(
        searchTerm
      )}&exact=false`;
      const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true, wait: 2200, timeout: 16000 });

      let count = 0;
      $('a[href*="/marketplace/item/"]').each((_, a) => {
        if (count >= 30) return false; // cap to keep searches fast
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

        const norm = this.normalize({ title, price, link, image, source: 'facebook' });
        if (norm) {
          listings.push(norm);
          count++;
        }
      });

      logger.info(`✅ Facebook: ${listings.length} items`);
      return listings.slice(0, 40);
    } catch (error) {
      logger.error(`❌ Facebook error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  /* ---------------------------
   * CashConverters
   * --------------------------- */
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
        const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true, timeout: 15000 });

        const cards = $('[data-testid="product-card"], .product-card, .c-product-card, .product, .product-tile');
        cards.each((_, el) => {
          const $item = $(el);
          const a = $item.find('a').first();
          let link = a.attr('href');
          const title =
            $item.find('h3, .title, [data-testid="product-title"], .product-title, .product-name').first().text().trim() ||
            a.text().trim();
          const price = $item.find('.price, [data-testid="product-price"], .product-price').first().text().trim();
          const image =
            $item.find('img').attr('src') || $item.find('img').attr('data-src') || $item.find('img').attr('data-lazy');

          if (link && link.startsWith('/')) link = `https://www.cashconverters.co.uk${link}`;

          const norm = this.normalize({
            title,
            price,
            link,
            image,
            source: 'cashConverters',
            location: 'United Kingdom',
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

  /* ---------------------------
   * Optional sources
   * --------------------------- */
  async searchVinted() { return []; } // unchanged (disabled)
  async searchDepop()  { return []; } // unchanged (disabled)
  async searchDiscogs(){ return []; } // unchanged (disabled)
  async searchGoogleShopping(){ return []; } // unchanged (disabled)
  async searchGoogleResults(){ return []; } // unchanged (disabled)

  /* ---------------------------
   * Utils
   * --------------------------- */
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

  /* ---------------------------
   * Mocks
   * --------------------------- */
  getMockGumtreeResults(searchTerm) { /* unchanged */ return []; }
  getMockEbayResults(searchTerm)    { /* unchanged */ return []; }
  getMockFacebookResults(searchTerm){ /* unchanged */ return []; }
  getMockCashConvertersResults(st)  { /* unchanged */ return []; }
}

export const scrapingService = new ScrapingService();
