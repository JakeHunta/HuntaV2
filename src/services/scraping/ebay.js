// eBay scraper that tries RSS first, then HTML fallback with union selectors.

import { parse } from "node-html-parser";
import { scrapeEbayRSS } from "./ebayRssService.js";
import { scrapingBee } from "../utils/scrapingBee.js";

export async function scrapeEbay(query, { page = 1 } = {}) {
  // 1) RSS first (most reliable)
  try {
    const rss = await scrapeEbayRSS(query, page);
    if (rss.length) {
      console.info(`✅ eBay (RSS): ${rss.length} items`);
      return rss;
    }
    console.warn("eBay RSS returned 0 items; trying HTML fallback.");
  } catch (e) {
    console.warn("eBay RSS failed; trying HTML fallback:", e?.message || e);
  }

  // 2) HTML fallback
  const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(
    query
  )}&_sop=12&_fsrp=1&LH_PrefLoc=3&_pgn=${page}`;

  // First pass, no JS
  let html = await scrapingBee({
    url,
    render_js: false,
    premium_proxy: true,
    block_resources: false, // allow more resources to reduce bot flags
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
    // Retry with JS render + wait
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
    blocked =
      !root.querySelector("#srp-river-results, [data-testid='item-card']");
    if (blocked) {
      console.warn("eBay HTML appears blocked after retry; returning 0.");
      return [];
    }
  }

  const items = parseEbayItems(root);
  console.info(`✅ eBay (HTML): ${items.length} items`);
  return items;
}

function parseEbayItems(root) {
  const candidates = [
    ...root.querySelectorAll("li.s-item"),
    ...root.querySelectorAll("[data-testid='item-card']"), // new/grid layout
  ];

  const items = candidates
    .map((el) => {
      const link =
        el.querySelector("a.s-item__link")?.getAttribute("href") ||
        el
          .querySelector("[data-testid='item-card-title'] a")
          ?.getAttribute("href");
      const title =
        el.querySelector("h3.s-item__title")?.text?.trim() ||
        el
          .querySelector("[data-testid='item-card-title'] a")
          ?.text?.trim();
      const price =
        el.querySelector(".s-item__price")?.text?.trim() ||
        el
          .querySelector("[data-testid='item-card-price']")
          ?.text?.trim();
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

  return items;
}
