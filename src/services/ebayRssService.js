// eBay via RSS: very stable, no JS, less bot friction.

import axios from "axios";
import { parse } from "node-html-parser";

export async function scrapeEbayRSS(query, page = 1) {
  const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(
    query
  )}&_sop=12&_pgn=${page}&_rss=1`;

  const { data } = await axios.get(url, {
    headers: {
      Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    },
    timeout: 15000,
  });

  const root = parse(data);
  const items = root.querySelectorAll("item");

  const parsed = items.map((it) => {
    const title = it.querySelector("title")?.text?.trim();
    const link = it.querySelector("link")?.text?.trim();
    const desc = it.querySelector("description")?.text || "";
    const guid = it.querySelector("guid")?.text?.trim();
    const pubDate = it.querySelector("pubDate")?.text?.trim();

    // price often embedded inside description: "£12.99 Buy it now"
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

  return parsed.filter((x) => x.title && x.url);
}
