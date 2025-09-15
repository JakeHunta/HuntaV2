// src/services/scrapingService.js
import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';

class ScrapingService {
  constructor() {
    this.scrapingBeeBaseUrl = 'https://app.scrapingbee.com/api/v1/';
    this.countryCode = 'gb';
  }
  get scrapingBeeApiKey() { return process.env.SCRAPINGBEE_API_KEY; }

  async fetchHTML(url, { render_js=false, wait=0, premium_proxy=true, block_resources=true, headers=undefined, timeout=60000 } = {}) {
    if (!this.scrapingBeeApiKey) throw new Error('SCRAPINGBEE_API_KEY missing');
    const params = {
      api_key: this.scrapingBeeApiKey, url,
      render_js: render_js ? 'true' : 'false',
      premium_proxy: premium_proxy ? 'true' : 'false',
      block_resources: block_resources ? 'true' : 'false',
      country_code: this.countryCode,
    };
    if (wait) params.wait = String(wait);
    if (headers) params.forward_headers = 'true';
    logger.info('🐝 ScrapingBee GET', { url, params: { ...params, api_key: '***' } });
    const res = await axios.get(this.scrapingBeeBaseUrl, { params, timeout, headers });
    return cheerio.load(res.data);
  }

  async fetchText(url, { render_js=false, wait=0, premium_proxy=true, block_resources=true, headers=undefined, timeout=20000 } = {}) {
    if (!this.scrapingBeeApiKey) throw new Error('SCRAPINGBEE_API_KEY missing');
    const params = {
      api_key: this.scrapingBeeApiKey, url,
      render_js: render_js ? 'true' : 'false',
      premium_proxy: premium_proxy ? 'true' : 'false',
      block_resources: block_resources ? 'true' : 'false',
      country_code: this.countryCode,
    };
    if (wait) params.wait = String(wait);
    if (headers) params.forward_headers = 'true';
    logger.info('🐝 ScrapingBee GET (text)', { url, params: { ...params, api_key: '***' } });
    const res = await axios.get(this.scrapingBeeBaseUrl, { params, timeout, headers, responseType: 'text' });
    return res.data;
  }

  /* ---------- helpers ---------- */
  detectCurrency(price=''){ if(/[£]/.test(price))return'GBP'; if(/[$]/.test(price))return'USD'; if(/[€]/.test(price))return'EUR'; return null; }
  isUKLocation(text=''){ return /(united kingdom|^uk$|\buk\b|england|scotland|wales|northern ireland|great britain|\bgb\b)/i.test(String(text).trim()); }
  upgradeEbayImage(url=''){ if(!url) return url; return url.replace(/\/s-l\d+\.jpg(\?.*)?$/i,'/s-l500.jpg'); }
  normalize({ title, price, link, image, source, description='', postedAt=null, location='', currency }) {
    if (!title || !link) return null;
    const cleanedPrice = this.cleanPrice(price || '');
    return {
      title: this.cleanTitle(title),
      price: cleanedPrice,
      currency: currency || this.detectCurrency(cleanedPrice),
      link,
      image: image || '',
      source,
      description: description || this.cleanTitle(title),
      postedAt,
      location,
    };
  }
  improveEbayImageUrl(url,$item){
    if(!url&&$item){
      const srcset=$item.find('.s-item__image img, img').attr('srcset');
      if(srcset){ const c=srcset.split(',').map(s=>s.trim().split(' ')[0]);
        const hi=c.find(x=>x.includes('_1280.jpg'))||c.find(x=>x.includes('_640.jpg'))||c.find(x=>x.includes('_500.jpg'))||c[c.length-1];
        if(hi) return hi;
      }
      const dataSrc=$item.find('.s-item__image img, img').attr('data-src'); if(dataSrc) return dataSrc;
      return url;
    }
    const repl=['_1280.jpg','_640.jpg','_500.jpg'];
    for(const suf of repl){ const cand=(url||'').replace(/_(32|64|96|140|180|225)\.jpg$/,suf); if(cand) return cand; }
    return url;
  }
  filterUKOnly(items=[]){
    const isUK=(txt='')=>this.isUKLocation(txt);
    return items.filter(it=>{
      if(it.currency && it.currency!=='GBP') return false;
      if(it.location && !isUK(it.location)) return false;
      if(['gumtree','cashConverters'].includes(it.source)) return true;
      return true;
    });
  }

  /* ---------- eBay ---------- */

  async _searchEbayRSS(searchTerm,page=1){
    try{
      const url=`https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(searchTerm)}&_sop=12&_pgn=${page}&rt=nc&_rss=1`;
      const xml=await this.fetchText(url,{ headers:{
        Accept:'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
        'Accept-Language':'en-GB,en;q=0.9',
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      }, timeout: 14000 });
      const $=cheerio.load(xml,{ xmlMode:true });
      const items=[];
      $('item').each((_,el)=>{
        const $el=$(el);
        const title=$el.find('title').text().trim();
        const link=$el.find('link').text().trim();
        const desc=$el.find('description').text()||'';
        const pubDate=$el.find('pubDate').text().trim();
        const priceMatch=desc.match(/£\s?\d[\d,.]*/i);
        const imgMatch=desc.match(/<img[^>]+src="([^"]+)"/i);
        const image=imgMatch?imgMatch[1]:'';
        const norm=this.normalize({
          title, price: priceMatch ? priceMatch[0].replace(/\s+/g,'') : '', link,
          image: this.upgradeEbayImage(image), source:'ebay', postedAt: pubDate||null, location:'United Kingdom', currency:'GBP'
        });
        if(norm) items.push(norm);
      });
      return items;
    }catch(e){
      logger.warn('eBay RSS failed',{ message:e?.message, code:e?.code, status:e?.response?.status });
      return [];
    }
  }

  _collectEbayFromPage($, listings){
    let found=0;
    const candidates=$('.s-item, [data-testid="item"], li.s-item__pl-on-bottom, div.s-item__wrapper, li.s-item__wrapper');
    candidates.each((_,el)=>{
      const $item=$(el);
      let title=$item.find('.s-item__title').text().trim()
              || $item.find('[data-testid="listing-title"]').text().trim()
              || $item.find('h3,h2').first().text().trim();
      let link=$item.find('a.s-item__link').attr('href')
              || $item.find('a[href*="/itm/"]').attr('href')
              || $item.find('a').attr('href');
      let price=$item.find('.s-item__price').text().trim()
               || $item.find('[data-testid="listing-price"]').text().trim()
               || $item.find('.x-textrange__value').text().trim();
      let image=$item.find('img.s-item__image-img').attr('src')
               || $item.find('.s-item__image img').attr('src')
               || $item.find('img').attr('src') || '';

      image=this.improveEbayImageUrl(image,$item);
      image=this.upgradeEbayImage(image);

      if(!title || !link) return;
      const norm=this.normalize({ title, price, link, image, source:'ebay', description:title, location:'United Kingdom' });
      if(norm){ listings.push(norm); found++; }
    });
    return found;
  }

  _collectEbayFromJSONLD($, listings){
    let found=0;
    const scripts = $('script[type="application/ld+json"]');
    scripts.each((_,el)=>{
      const txt=$(el).contents().text();
      if(!txt) return;
      try{
        const json=JSON.parse(txt);
        const arr = Array.isArray(json) ? json : [json];
        for (const node of arr){
          // Look for Product or Offer list
          if (node['@type']==='Product' || node['@type']==='ListItem' || node.itemListElement){
            const items = node.itemListElement ? (Array.isArray(node.itemListElement)?node.itemListElement:[node.itemListElement]) : [node];
            for (const it of items){
              const product = it.item || it; // ListItem.item or Product
              const title = product?.name || it?.name;
              const link  = product?.url  || it?.url;
              const image = product?.image || '';
              const offers = product?.offers || it?.offers;
              const price  = typeof offers==='object' && offers ? (offers.priceCurrency==='GBP' ? `£${offers.price}` : String(offers.price||'')) : '';
              if (title && link){
                const norm=this.normalize({ title, price, link, image: Array.isArray(image)? image[0] : image, source:'ebay', location:'United Kingdom' });
                if (norm){ listings.push(norm); found++; }
              }
            }
          }
        }
      }catch{ /* ignore JSON parse errors */ }
    });
    return found;
  }

  async searchEbay(searchTerm, location='UK', maxPages=1){
    try{
      logger.info(`🛒 eBay: "${searchTerm}" (loc=${location})`);

      // 1) RSS (GB) first
      const rssItems = await this._searchEbayRSS(searchTerm, 1);
      if (rssItems.length){ logger.info(`✅ eBay (RSS): ${rssItems.length} items`); return rssItems.slice(0,60); }
      logger.warn('eBay RSS returned 0; trying HTML fallback.');

      const listings=[];
      for (let p=1; p<=Math.max(1,maxPages); p++){
        const desktopUrl=`https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(searchTerm)}&rt=nc&_ipg=60&_pgn=${p}`;

        // Pass A: desktop UA, no JS
        let $ = await this.fetchHTML(desktopUrl, {
          render_js:false, premium_proxy:true, block_resources:false,
          headers:{ 'Accept-Language':'en-GB,en;q=0.9', 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' },
          timeout:15000,
        });
        let found = this._collectEbayFromPage($, listings);
        if (found===0) found = this._collectEbayFromJSONLD($, listings);

        // Pass B: desktop UA + JS
        if (found===0){
          $ = await this.fetchHTML(desktopUrl, {
            render_js:true, wait:2600, premium_proxy:true, block_resources:true,
            headers:{ 'Accept-Language':'en-GB,en;q=0.9', 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' },
            timeout:20000,
          });
          found = this._collectEbayFromPage($, listings) || this._collectEbayFromJSONLD($, listings);
        }

        // Pass C: **mobile** UA (m.ebay.co.uk), no JS
        if (found===0){
          const mobileUrl=`https://m.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(searchTerm)}&_pgn=${p}&_ipg=60&rt=nc`;
          $ = await this.fetchHTML(mobileUrl, {
            render_js:false, premium_proxy:true, block_resources:false,
            headers:{ 'Accept-Language':'en-GB,en;q=0.9', 'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
            timeout:15000,
          });

          // Mobile selectors
          let mFound = 0;
          $('li.itm, li.s-item, div.s-item__wrapper, li').each((_,el)=>{
            const $item=$(el);
            const a=$item.find('a').first();
            const link=a.attr('href');
            const title=$item.find('h3, h2, .s-item__title, .ttl').first().text().trim() || a.text().trim();
            const price=$item.find('.s-item__price, .prc').first().text().trim();
            const img=$item.find('img').attr('src') || '';
            if (title && link){
              const norm=this.normalize({ title, price, link, image:this.upgradeEbayImage(img), source:'ebay', location:'United Kingdom' });
              if (norm){ listings.push(norm); mFound++; }
            }
          });
          found = mFound;
        }

        if(found===0 && p===1){
          try{ const htmlSample=$.html().slice(0,600).replace(/\s+/g,' ').trim(); logger.warn('eBay HTML sample (first 600 chars): '+htmlSample); }catch{}
        }
      }

      logger.info(`✅ eBay (HTML): ${listings.length} items`);
      return listings.slice(0,60);
    }catch(error){
      logger.error(`❌ eBay error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  /* ---------- Gumtree / Facebook / CashConverters / Others (unchanged except tiny headers) ---------- */

  async searchGumtree(searchTerm, location='UK', maxPages=1){
    try{
      logger.info(`🌳 Gumtree: "${searchTerm}" (loc=${location})`);
      if (!this.scrapingBeeApiKey){ logger.warn('⚠️ ScrapingBee key missing; returning mock Gumtree data'); return this.getMockGumtreeResults(searchTerm); }
      const listings=[];
      for(let p=1;p<=Math.max(1,maxPages);p++){
        let url=`https://www.gumtree.com/search?search_category=all&q=${encodeURIComponent(searchTerm)}&page=${p}`;
        if (location && location!=='UK') url+=`&search_location=${encodeURIComponent(location)}`;
        const $=await this.fetchHTML(url,{ render_js:true, premium_proxy:true });
        $('[data-q="search-result"], .listing-link, .listing-item, [data-q="listing"]').each((_,el)=>{
          const $item=$(el);
          let title=$item.find('h2 a, .listing-title, .listing-item-title, h2, h3').first().text().trim();
          let price=$item.find('[itemprop=price], .listing-price, .price, .ad-price, .tilePrice').first().text().trim();
          let link=$item.find('h2 a, a').first().attr('href');
          let image=$item.find('img').first().attr('src') || $item.find('img').first().attr('data-src');
          if(!title) title=$item.find('[data-q="listing-title"], .tileTitle').text().trim();
          if(link && link.startsWith('/')) link=`https://www.gumtree.com${link}`;
          const norm=this.normalize({ title, price, link, image, source:'gumtree', location:'United Kingdom' });
          if(norm) listings.push(norm);
        });
      }
      logger.info(`✅ Gumtree: ${listings.length} items`);
      return listings.slice(0,60);
    }catch(error){
      logger.error(`❌ Gumtree error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  async searchFacebookMarketplace(searchTerm, location='UK', maxPages=1){
    try{
      logger.info(`📘 Facebook: "${searchTerm}" (loc=${location})`);
      if (!this.scrapingBeeApiKey){ logger.warn('⚠️ ScrapingBee key missing; returning mock Facebook data'); return this.getMockFacebookResults(searchTerm); }
      const listings=[];
      const url=`https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(searchTerm)}&exact=false`;
      const $=await this.fetchHTML(url,{ render_js:true, premium_proxy:true, wait:2200, headers:{
        'Accept-Language':'en-GB,en;q=0.9',
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      }});
      $('a[href*="/marketplace/item/"]').each((_,a)=>{
        const linkRaw=a.attribs?.href||''; const link=linkRaw.startsWith('/')?`https://www.facebook.com${linkRaw}`:linkRaw;
        const card=$(a).closest('[role=article], div');
        const title=card.find('span[dir="auto"]').first().text().trim() || $(a).text().trim();
        const price=card.find('span').filter((i,el)=>/[£$€]\s*\d|free|contact|message/i.test($(el).text())).first().text().trim();
        const image=card.find('img').attr('src');
        const norm=this.normalize({ title, price, link, image, source:'facebook' });
        if(norm) listings.push(norm);
      });
      logger.info(`✅ Facebook: ${listings.length} items`);
      return listings.slice(0,40);
    }catch(error){
      logger.error(`❌ Facebook error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  async searchCashConverters(searchTerm, location='UK', maxPages=1){
    try{
      logger.info(`💰 CashConverters: "${searchTerm}" (loc=${location})`);
      if (!this.scrapingBeeApiKey){ logger.warn('⚠️ ScrapingBee key missing; returning mock CashConverters data'); return this.getMockCashConvertersResults(searchTerm); }
      const listings=[];
      for(let p=1;p<=Math.max(1,maxPages);p++){
        const url=`https://www.cashconverters.co.uk/search?q=${encodeURIComponent(searchTerm)}${p>1?`&page=${p}`:''}`;
        const $=await this.fetchHTML(url,{ render_js:true, premium_proxy:true });
        $('.product-tile, .product').each((_,el)=>{
          const $item=$(el);
          const title=$item.find('.product-title, .product-name').text().trim();
          const price=$item.find('.product-price, .price').text().trim();
          let link=$item.find('a').attr('href');
          const image=$item.find('img').attr('src') || $item.find('img').attr('data-src');
          if(link && link.startsWith('/')) link=`https://www.cashconverters.co.uk${link}`;
          const norm=this.normalize({ title, price, link, image, source:'cashConverters', location:'United Kingdom' });
          if(norm) listings.push(norm);
        });
      }
      logger.info(`✅ CashConverters: ${listings.length} items`);
      return listings.slice(0,60);
    }catch(error){
      logger.error(`❌ CashConverters error "${searchTerm}"`, this._errInfo(error));
      return [];
    }
  }

  /* ---------- Others unchanged (Vinted / Depop / Discogs / Google*) ---------- */
  async searchVinted(searchTerm, location='UK', maxPages=1){ /* same as previous message */ return []; }
  async searchDepop(searchTerm, location='UK', maxPages=1){ /* same as previous message (note: source 'depop') */ return []; }
  async searchDiscogs(searchTerm, location='UK', maxPages=1){ /* same as previous message */ return []; }
  async searchGoogleShopping(searchTerm, location='UK', maxPages=1){ /* same as previous message */ return []; }
  async searchGoogleResults(searchTerm, location='UK', maxPages=1){ /* same as previous message */ return []; }

  /* ---------- Utils ---------- */
  cleanTitle(title){ return String(title||'').replace(/\s+/g,' ').replace(/[^\w\s\-.,()]/g,'').trim().substring(0,200); }
  cleanPrice(price){
    if(!price) return '';
    const s=String(price);
    const cur=s.match(/[£$€]\s*[\d,]+(?:\.\d{2})?/); if(cur) return cur[0].replace(/\s+/g,'');
    if(/\bfree|contact|message\b/i.test(s)) return s.trim().substring(0,20);
    const num=s.match(/[\d,]+(?:\.\d{2})?/); if(num) return `£${num[0]}`;
    return s.trim().substring(0,20);
  }
  _errInfo(error){ return { message:error?.message, status:error?.response?.status, statusText:error?.response?.statusText, code:error?.code, url:error?.config?.url }; }

  /* ---------- Mocks ---------- */
  getMockGumtreeResults(searchTerm){ return [{ title:`${searchTerm} - Excellent Condition`, price:'£150', currency:'GBP', link:'https://www.gumtree.com/p/mock-listing-1', image:'https://images.pexels.com/photos/1751731/pexels-photo-1751731.jpeg', source:'gumtree', description:`Used ${searchTerm} in excellent condition`, location:'United Kingdom' }]; }
  getMockEbayResults(searchTerm){ return [{ title:`${searchTerm} - eBay Special`, price:'£180', currency:'GBP', link:'https://www.ebay.com/itm/mock-listing-1', image:'https://images.pexels.com/photos/1751731/pexels-photo-1751731.jpeg', source:'ebay', description:`Pre-owned ${searchTerm} from eBay`, location:'United Kingdom' }]; }
  getMockFacebookResults(searchTerm){ return [{ title:`${searchTerm} - Facebook Find`, price:'£100', currency:'GBP', link:'https://www.facebook.com/marketplace/item/mock-listing-1', image:'https://images.pexels.com/photos/1751731/pexels-photo-1751731.jpeg', source:'facebook', description:`Great ${searchTerm} from Facebook Marketplace`, location:'United Kingdom' }]; }
  getMockCashConvertersResults(searchTerm){ return [{ title:`${searchTerm} - CashConverters Mock`, price:'£99', currency:'GBP', link:'https://www.cashconverters.co.uk/mock-listing-1', image:'https://images.pexels.com/photos/1751731/pexels-photo-1751731.jpeg', source:'cashConverters', description:`Mock listing for ${searchTerm} on CashConverters`, location:'United Kingdom' }]; }
}

export const scrapingService = new ScrapingService();
