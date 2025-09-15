import { scrapingBee } from "../utils/scrapingBee.js";
import { parse } from "node-html-parser";

export async function scrapeCashConverters(query) {
  const url = `https://www.cashconverters.co.uk/search?q=${encodeURIComponent(query)}`;

  try {
    const html = await scrapingBee({
      url,
      render_js: true,
      wait: 2500,
      premium_proxy: true,
      block_resources: true,
      country_code: "gb",
      timeout: 20000,
    });

    const root = parse(html);
    const cards = root.querySelectorAll("[data-testid='product-card'], .product-card, .c-product-card");

    const items = cards.map((el) => {
      const a = el.querySelector("a");
      const link = a?.getAttribute("href");
      const title = el.querySelector("h3, .title, [data-testid='product-title']")?.text?.trim() || a?.text?.trim();
      const price = el.querySelector(".price, [data-testid='product-price']")?.text?.trim() || null;
      const img = el.querySelector("img")?.getAttribute("src") || el.querySelector("img")?.getAttribute("data-src") || null;

      if (!link || !title) return null;
      const absolute = link.startsWith("http") ? link : `https://www.cashconverters.co.uk${link}`;
      return {
        id: absolute,
        source: "cashconverters",
        title,
        url: absolute,
        price,
        image: img,
        currency: "GBP",
        location: "UK",
      };
    }).filter(Boolean);

    console.info(`✅ CashConverters: ${items.length} items`);
    return items;
  } catch (e) {
    const beeStatus = e?.response?.status;
    const original = e?.response?.data?.original_status;
    if (beeStatus === 404 || original === 404) {
      console.warn("CashConverters 404 (treating as empty set).");
      return [];
    }
    console.warn("CashConverters error (non-404):", e?.message || e);
    return []; // stay resilient in aggregate
  }
}
