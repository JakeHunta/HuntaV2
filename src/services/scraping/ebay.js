// src/services/scraping/ebay.js
console.info("🧩 ebay.js loaded (RSS-first)");

import axios from "axios";
import { parse } from "node-html-parser";
import { scrapingBee } from "../../utils/scrapingBee.js";

async function scrapeEbayRSS(query, page = 1) {
  const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(query)}&_sop=12&_pgn=${page}&_rss=1`;
  const { data } = await axios.get(url, {
    headers: {
      Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    },
    timeout: 15000,
  });

  const root = parse(data);
  const items = root.querySelectorAll("item").map((it) => {
    const title = it.querySelector("title")?.text?.trim();
    const link = it.querySelector("link")?.text?.trim();
    const desc = it.querySelector("description")?.text || "";
    const guid = it.querySelector("guid")?.text?.trim();
    const pubDate = it.querySelector("pubDate")?.text?.trim();

    const priceMatch = desc.match(/£\s?\d[\d,.]*/i);
    const imgMatch = desc.match(/<img[^>]+src="([^"]+)"/i);

    return {
      id: guid || link,
      source: "ebay",
      title,
      url: link,
      price: priceMatch ? priceMatch[0].replace(/\s/g, "") : null,
      currency: "GBP",
      image: imgMatch ? imgMatch[1] : null,
      postedAt: pubDate || null,
      location: "UK",
    };
  });

  return items.filter((x) => x.title && x.url);
}

function parseEbayItemsFromHTML(root) {
  const nodes = [
    ...root.querySelectorAll("li.s-item"),
    ...root.querySelectorAll("[data-testid='item-card']"),
  ];

  return nodes
    .map((el) => {
      const link =
        el.querySelector("a.s-item__link")?.getAttribute("href") ||
        el.querySelector("[data-testid='item-card-title'] a")?.getAttribute("href");
      const title =
        el.querySelector("h3.s-item__title")?.text?.trim() ||
        el.querySelector("[data-testid='item-card-title'] a")?.text?.trim();
      const price =
        el.querySelector(".s-item__price")?.text?.trim() ||
        el.querySelector("[data-testid='item-card-price']")?.text?.trim();
      const img =
        el.querySelector("img.s-item__image-img")?.getAttribute("src") ||
        el.querySelector("img")?.getAttribute("src");

      if (!link || !title) return null;
      return {
        id: link,
        source: "ebay",
        title,
        url: link,
        price: price || null,
        image: img || null,
        currency: "GBP",
        location: "UK",
      };
    })
    .filter(Boolean);
}

export async function scrapeEbay(query, { page = 1 } = {}) {
  // 1) RSS first
  try {
    const rss = await scrapeEbayRSS(query, page);
    if (rss.length) {
      console.info(`✅ eBay (RSS): ${rss.length} items`);
      return rss;
    }
    console.warn("eBay RSS returned 0; trying HTML fallback.");
  } catch (e) {
    console.warn("eBay RSS failed; trying HTML fallback:", e?.message || e);
  }

  // 2) HTML fallback
  const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(query)}&_sop=12&_fsrp=1&LH_PrefLoc=3&_pgn=${page}`;

  let html = await scrapingBee({
    url,
    render_js: false,
    premium_proxy: true,
    block_resources: false,
    country_code: "gb",
    headers: {
      "Accept-Language": "en-GB,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    },
    timeout: 20000,
  });

  let root = parse(html);
  let blocked =
    !root.querySelector("#srp-river-results, [data-testid='item-card']") ||
    /captcha|access denied|bot/i.test(root.text);

  if (blocked) {
    html = await scrapingBee({
      url,
      render_js: true,
      wait: 3000,
      premium_proxy: true,
      block_resources: true,
      country_code: "gb",
      timeout: 25000,
    });
    root = parse(html);
    blocked = !root.querySelector("#srp-river-results, [data-testid='item-card']");
    if (blocked) {
      console.warn("eBay HTML appears blocked after retry; returning 0.");
      return [];
    }
  }

  const items = parseEbayItemsFromHTML(root);
  console.info(`✅ eBay (HTML): ${items.length} items`);
  return items;
}
