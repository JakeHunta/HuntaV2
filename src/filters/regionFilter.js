const UK_LOCATION_RE = /\b(uk|united\s*kingdom|england|scotland|wales|northern\s+ireland)\b/i;
const UK_TLD_RE = /\.co\.uk\b|\.uk\b/i;

// Keeps listing if any UK signal is present.
// If the filter would remove ALL items, it returns the original list (fail-open).
export function filterByRegion(items, region = "UK") {
  if (!Array.isArray(items) || items.length === 0) return items;
  if (!region || region.toUpperCase() !== "UK") return items;

  const kept = items.filter((it) => {
    const loc = (it.location || "").trim();
    const cur = (it.currency || "").trim().toUpperCase();
    const url = String(it.url || "");
    const fbOK = it.source === "facebook"; // FB already geoscoped (country_code=gb)

    const locOK = loc && UK_LOCATION_RE.test(loc);
    const curOK = cur === "GBP";
    const tldOK = UK_TLD_RE.test(url);

    return locOK || curOK || tldOK || fbOK;
  });

  if (kept.length === 0) {
    console.info("ℹ️ Region filter would remove all items — returning unfiltered set.");
    return items;
  }
  return kept;
}
