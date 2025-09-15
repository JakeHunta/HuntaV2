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
   * Fetch a page through ScrapingBee and return Cheerio $ (or raw text if mode==='text')
   */
  async fetchHTML(
    url,
    {
      render_js = false,
      wait = 0,
      premium_proxy = true,
      block_resources = true,
      forward_headers = true,
      timeout = 60000,
      mode = 'html', // 'html' | 'text'
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
      forward_headers: forward_headers ? 'true' : 'false',
    };
    if (wait) params.wait = String(wait);

    const logParams = { ...params, api_key: '***' };
    logger.info(`🐝 ScrapingBee GET${mode === 'text' ? ' (text)' : ''}`, { url, params: logParams });

    const res = await axios.get(this.scrapingBeeBaseUrl, { params, timeout });
    if (mode === 'text') return res.data;
    return cheerio.load(res.data);
  }

  /* ------------------- helpers ------------------- */

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

  // eBay thumbnails → bigger
  upgradeEbayImage(url = '') {
    if (!url) return url;
    let out = url.replace(/\/s-l(\d+)\.jpg(\?.*)?$/i, '/s-l640.jpg');
    out = out.replace(/_(32|64|96|140|180|225)\.jpg$/i, '_640.jpg');
    return out;
  }

  // Find the best-guess <img> URL on a node (handles src, data-src, data-image, data-img JSON)
  extractImg($ctx) {
    const direct =
      $ctx.find('img').first().attr('src') ||
      $ctx.find('img').first().attr('data-src') ||
      $ctx.find('img').first().attr('data-image-src') ||
      '';

    if (direct) return direct;

    // Some sites put JSON in data-img like {"src":"..."}
    const dataImg = $ctx.find('img').first().attr('data-img');
    if (dataImg) {
      try {
        const j = JSON.parse(dataImg);
        if (j && j.src) return j.src;
      } catch {}
    }
    return '';
  }

  // Keep both priceLabel (raw) and price (cleaned) so the frontend can show native symbols
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

    const priceLabel = this.cleanPriceLabel(price || '');
    const currency = this.detectCurrency(priceLabel);
    return {
      title: this.cleanTitle(title),
      price: priceLabel,          // keep as string with symbol; frontend parses numeric + shows label
      priceLabel,                 // explicit copy for the client
      currency,                   // GBP/EUR/USD when detectable
      link,
      url: link,
      image: image || '',
      source,
      description: description || '',
      postedAt,
      location,
    };
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

  /* ---------------- eBay (RSS → desktop → mobile) ---------------- */

  async searchEbay(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`🛒 eBay: "${searchTerm}" (loc=${location})`);
      if (!this.scrapingBeeApiKey) {
        logger.warn('⚠️ ScrapingBee key missing; returning mock eBay data');
        return this.getMockEbayResults(searchTerm);
      }

      const listings = [];

      // A) RSS (fast, often empty)
      try {
        const rssUrl = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(searchTerm)}&_sop=12&_pgn=1&rt=nc&_rss=1`;
        const xml = await this.fetchHTML(rssUrl, { render_js: false, mode: 'text' });
        const $ = cheerio.load(xml, { xmlMode: true });
        $('item').each((_, el) => {
          const title = $(el).find('title').first().text().trim();
          const link = $(el).find('link').first().text().trim();
          const priceLabel =
            $(el).find('ebay\\:currentprice, currentprice').first().text().trim() ||
            $(el).find('g\\:price, price').first().text().trim() ||
            '';
          const image =
            $(el).find('media\\:thumbnail, thumbnail').attr('url') || '';
          const loc = $(el).find('location, ebay\\:location').first().text().trim() || '';

          const norm = this.normalize({
            title,
            price: priceLabel,
            link,
            image: this.upgradeEbayImage(image),
            source: 'ebay',
            location: loc
          });
          if (norm) listings.push(norm);
        });
        if (listings.length > 0) {
          logger.info(`✅ eBay (RSS): ${listings.length} items`);
          return listings.slice(0, 80);
        } else {
          logger.info('eBay RSS returned 0; trying HTML fallback.');
        }
      } catch (rssErr) {
        logger.warn(`⚠️ eBay RSS parse failed: ${rssErr?.message || rssErr}`);
      }

      const parseDesktop = ($) => {
        const out = [];
        $('.s-item').each((_, el) => {
          const $item = $(el);
          const title = $item.find('.s-item__title').text().trim();
          const link = $item.find('.s-item__link').attr('href');
          // price text could be "£120.00", "£120.00 to £150.00" — keep raw and let client format
          let priceLabel = $item.find('.s-item__price').first().text().trim();
          if (!priceLabel) {
            priceLabel = $item.find('[aria-label^="£"], [aria-label^="$"], [aria-label^="€"]').first().text().trim();
          }

          // image: several fallbacks
          let image =
            $item.find('.s-item__image img.s-item__image-img').attr('src') ||
            $item.find('.s-item__image img.s-item__image-img').attr('data-src') ||
            this.extractImg($item.find('.s-item__image')) ||
            '';

          if (image) image = this.upgradeEbayImage(image);
          const locationText = $item.find('.s-item__location, .s-item__itemLocation').text().trim();

          if (!title || !link) return;
          if (/shop on ebay/i.test(title)) return;

          const norm = this.normalize({
            title,
            price: priceLabel,
            link,
            image,
            source: 'ebay',
            description: title,
            location: locationText
          });
          if (norm) out.push(norm);
        });
        return out;
      };

      const parseMobile = ($) => {
        const out = [];
        $('li.s-item, a[href*="/itm/"]').each((_, el) => {
          const $el = $(el);
          const $card = $el.is('li.s-item') ? $el : $el.closest('li.s-item').length ? $el.closest('li.s-item') : $el;

          let title =
            $card.find('.s-item__title').first().text().trim() ||
            $card.find('h3, h2').first().text().trim() ||
            $el.attr('title')?.trim() ||
            $el.text().trim();

          let link = $card.find('a.s-item__link').attr('href') || $el.attr('href') || '';
          if (link && link.startsWith('/')) link = `https://m.ebay.co.uk${link}`;

          let priceLabel =
            $card.find('.s-item__price').first().text().trim() ||
            $card.find('[aria-label^="£"], [aria-label^="$"], [aria-label^="€"]').first().text().trim() ||
            '';

          let image =
            $card.find('img.s-item__image-img').first().attr('src') ||
            $card.find('img.s-item__image-img').first().attr('data-src') ||
            this.extractImg($card) ||
            '';
          if (image) image = this.upgradeEbayImage(image);

          const loc =
            $card.find('.s-item__location, .s-item__itemLocation').first().text().trim() || '';

          if (!title || !link) return;

          const norm = this.normalize({
            title,
            price: priceLabel,
            link,
            image,
            source: 'ebay',
            description: title,
            location: loc
          });
          if (norm) out.push(norm);
        });
        return out;
      };

      // B) Desktop pages
      const desktopUrl = (p = 1) =>
        `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(searchTerm)}&rt=nc&_ipg=60&_pgn=${p}`;
      for (let p = 1; p <= Math.max(1, maxPages); p++) {
        const $ = await this.fetchHTML(desktopUrl(p), {
          render_js: false,
          premium_proxy: true,
          block_resources: false,
          forward_headers: true,
          timeout: 60000
        });
        const pageItems = parseDesktop($);
        pageItems.forEach(x => listings.push(x));
      }

      // C) Mobile fallback (if desktop gave 0)
      if (listings.length === 0) {
        const mobileUrl = (p = 1) =>
          `https://m.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(searchTerm)}&_pgn=${p}&_ipg=60&rt=nc`;
        for (let p = 1; p <= Math.max(1, maxPages); p++) {
          const $m = await this.fetchHTML(mobileUrl(p), {
            render_js: false,
            premium_proxy: true,
            block_resources: false,
            forward_headers: true,
            timeout: 60000
          });
          const pageItems = parseMobile($m);
          pageItems.forEach(x => listings.push(x));
        }
      }

      logger.info(`✅ eBay (HTML): ${listings.length} items`);
      return listings.slice(0, 120);
    } catch (error) {
      logger.error(`❌ eBay error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  /* ---------------- Gumtree ---------------- */

  async searchGumtree(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`🌳 Gumtree: "${searchTerm}" (loc=${location})`);
      if (!this.scrapingBeeApiKey) {
        logger.warn('⚠️ ScrapingBee key missing; returning mock Gumtree data');
        return this.getMockGumtreeResults(searchTerm);
      }

      const listings = [];
      for (let p = 1; p <= Math.max(1, maxPages); p++) {
        let url = `https://www.gumtree.com/search?search_category=all&q=${encodeURIComponent(searchTerm)}&page=${p}`;
        if (location && location !== 'UK') url += `&search_location=${encodeURIComponent(location)}`;

        const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true });

        $('[data-q="search-result"], .listing-link, .listing-item, [data-q="listing"]').each((_, el) => {
          const $item = $(el);
          let title = $item.find('h2 a, .listing-title, .listing-item-title, h2, h3').first().text().trim();
          let priceLabel = $item
            .find('[itemprop=price], .listing-price, .price, .ad-price, .tilePrice')
            .first()
            .text()
            .trim();
          let link = $item.find('h2 a, a').first().attr('href');
          let image = this.extractImg($item);
          if (link && link.startsWith('/')) link = `https://www.gumtree.com${link}`;

          const norm = this.normalize({
            title,
            price: priceLabel,
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

  /* ---------------- Facebook Marketplace (best effort) ---------------- */

  async searchFacebookMarketplace(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`📘 Facebook: "${searchTerm}" (loc=${location})`);
      if (!this.scrapingBeeApiKey) {
        logger.warn('⚠️ ScrapingBee key missing; returning mock Facebook data');
        return this.getMockFacebookResults(searchTerm);
      }

      const listings = [];
      const url = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(searchTerm)}&exact=false`;
      const $ = await this.fetchHTML(url, {
        render_js: true,
        premium_proxy: true,
        wait: 2200,
        forward_headers: true
      });

      // Each item card link
      $('a[href*="/marketplace/item/"]').each((_, a) => {
        const linkRaw = a.attribs?.href || '';
        let link = linkRaw.startsWith('/') ? `https://www.facebook.com${linkRaw}` : linkRaw;

        const card = $(a).closest('[role=article], div');
        const title =
          card.find('span[dir="auto"]').first().text().trim() ||
          $(a).text().trim();
        const priceLabel = card
          .find('span')
          .filter((i, el) => /[£$€]\s*\d/.test($(el).text()))
          .first()
          .text()
          .trim();

        // Try to pull an image; FB can be finicky — we grab the nearest <img>
        let image =
          card.find('img').first().attr('src') ||
          card.find('img').first().attr('data-src') ||
          '';

        const norm = this.normalize({
          title,
          price: priceLabel,
          link,
          image,
          source: 'facebook',
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

  /* ---------------- CashConverters ---------------- */

  async searchCashConverters(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`💰 CashConverters: "${searchTerm}" (loc=${location})`);
      if (!this.scrapingBeeApiKey) {
        logger.warn('⚠️ ScrapingBee key missing; returning mock CashConverters data');
        return this.getMockCashConvertersResults(searchTerm);
      }

      const listings = [];
      for (let p = 1; p <= Math.max(1, maxPages); p++) {
        const url = `https://www.cashconverters.co.uk/search?q=${encodeURIComponent(searchTerm)}${p > 1 ? `&page=${p}` : ''}`;
        const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true });

        $('.product-tile, .product').each((_, el) => {
          const $item = $(el);
          const title = $item.find('.product-title, .product-name').text().trim();
          const priceLabel = $item.find('.product-price, .price').text().trim();
          let link = $item.find('a').attr('href');
          const image = this.extractImg($item);
          if (link && link.startsWith('/')) link = `https://www.cashconverters.co.uk${link}`;

          const norm = this.normalize({
            title,
            price: priceLabel,
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

  /* ---------------- Optional sources (unchanged) ---------------- */

  async searchVinted(searchTerm, location = 'UK', maxPages = 1) {
    try {
      logger.info(`🧥 Vinted: "${searchTerm}"`);
      if (!this.scrapingBeeApiKey) return [];

      const listings = [];
      for (let p = 1; p <= Math.max(1, maxPages); p++) {
        const url = `https://www.vinted.co.uk/catalog?search_text=${encodeURIComponent(searchTerm)}&page=${p}`;
        const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true });

        $('[data-testid="item-box"]').each((_, el) => {
          const aHref = $(el).find('a').attr('href');
          const link = aHref ? `https://www.vinted.co.uk${aHref}` : null;
          const title = $(el).find('[data-testid="item-title"]').text().trim();
          const priceLabel = $(el).find('[data-testid="item-price"]').text().trim();
          const image = this.extractImg($(el));
          const norm = this.normalize({ title, price: priceLabel, link, image, source: 'vinted' });
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
          const priceLabel = card
            .find('span')
            .filter((i, el) => /[£$€]\s*\d/.test($(el).text()))
            .first()
            .text()
            .trim();
          const image = this.extractImg(card);
          const norm = this.normalize({ title, price: priceLabel, link, image, source: 'depop' });
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
        const url = `https://www.discogs.com/sell/list?format=all&currency=GBP&q=${encodeURIComponent(searchTerm)}&page=${p}`;
        const $ = await this.fetchHTML(url, { render_js: false, premium_proxy: true });

        $('table#pjax_container tbody tr').each((_, tr) => {
          const title = $(tr).find('td.item_description a.item_description_title').text().trim();
          const link = 'https://www.discogs.com' + ($(tr).find('td.item_description a').attr('href') || '');
          const priceLabel = $(tr).find('td.price').text().trim();
          const image = this.extractImg($(tr));
          const norm = this.normalize({ title, price: priceLabel, link, image, source: 'discogs' });
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
      for (let p = 0; p < Math.min(1, maxPages); p++) {
        const url = `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(searchTerm)}&hl=en-GB&gl=gb`;
        const $ = await this.fetchHTML(url, { render_js: true, premium_proxy: true });

        $('a[href^="/shopping/product/"]').each((_, a) => {
          const link = `https://www.google.com${a.attribs?.href || ''}`;
          const card = $(a).closest('div');
          const title = $(a).text().trim();
          const priceLabel = card
            .find('span')
            .filter((i, el) => /[£$€]\s*\d/.test($(el).text()))
            .first()
            .text()
            .trim();
          const image = this.extractImg(card);
          const norm = this.normalize({ title, price: priceLabel, link, image, source: 'googleShopping' });
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
        const url = `https://www.google.com/search?q=${encodeURIComponent(searchTerm)}&num=10&start=${start}&hl=en-GB&gl=gb`;
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

          const hay = `${title} ${snippet}`.toLowerCase();
          if (!/(for sale|buy now|price|£|\$|€|in stock|add to cart|listing|shop|store|gumtree|ebay|facebook|depop|vinted|discogs|reverb)/.test(hay)) {
            return;
          }

          const norm = this.normalize({
            title,
            price: '',
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

  /* ---------------- utils ---------------- */

  cleanTitle(title) {
    return String(title || '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);
  }

  // Keep label as-is but trim and clip; don’t strip symbols (frontend needs them)
  cleanPriceLabel(price) {
    if (!price) return '';
    const s = String(price).replace(/\s+/g, ' ').trim();
    return s.substring(0, 60);
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

  /* ---------------- mocks ---------------- */

  getMockGumtreeResults(searchTerm) {
    return [
      {
        title: `${searchTerm} - Excellent Condition`,
        price: '£150',
        priceLabel: '£150',
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
        priceLabel: '£120',
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
        priceLabel: '£180',
        currency: 'GBP',
        link: 'https://www.ebay.co.uk/itm/mock-listing-1',
        image: 'https://i.ebayimg.com/images/g/abcd/s-l640.jpg',
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
        priceLabel: '£100',
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
        priceLabel: '£99',
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
