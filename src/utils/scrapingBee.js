// Robust ScrapingBee wrapper
// Ensures target URL is always passed, adds helpful upstream debug,
// and sets sane defaults that work well for eBay/FB/Gumtree.

import axios from "axios";

const BEE_BASE = "https://app.scrapingbee.com/api/v1/";

export async function scrapingBee({
  url,
  render_js = false,
  wait,
  premium_proxy = true,
  block_resources = true,
  country_code = "gb",
  headers = {},
  json_response = false,
  timeout = 20000,
}) {
  if (!url) throw new Error("ScrapingBee missing target url");

  const params = {
    api_key: process.env.SCRAPINGBEE_API_KEY,
    url,
    render_js: render_js ? "true" : "false",
    premium_proxy: premium_proxy ? "true" : "false",
    block_resources: block_resources ? "true" : "false",
    country_code,
  };
  if (wait) params.wait = String(wait);
  if (json_response) params.json_response = "true";

  try {
    const res = await axios.get(BEE_BASE, {
      params,
      headers,
      timeout,
    });
    return res.data;
  } catch (err) {
    const beeStatus = err?.response?.status;
    const data = err?.response?.data;
    if (json_response && data) {
      console.warn("ScrapingBee upstream:", {
        beeStatus,
        original_status: data.original_status,
        original_status_text: data.original_status_text,
      });
    }
    throw err;
  }
}
