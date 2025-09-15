// A permissive UK region filter with graceful fallback.
// Keeps items if ANY of these hold:
// - item.location mentions UK/United Kingdom or home nations
// - item.currency === 'GBP'
// - URL TLD suggests UK (.co.uk / .uk)
// - source is Facebook (already geo-scoped by country_code=gb via ScrapingBee)
// If the filter would remove ALL items, we FALL BACK to returning the unfiltered list.

const UK_LOCATION_RE = /\b(uk|united\s*kingdom|england|scotland|wales|northern\s+ireland)\b/i;
const UK_TLD_RE = /\.co\.uk\b|\.uk\b/i;

export function filterByRegion(items, region = 'UK') {
  if (!Array.isArray(items) || items.length === 0) return items;

  // Only UK is implemented; pass-through for others
  if (!region || region.toUpperCase() !== 'UK') return items;

  const kept = items.filter((it) => {
    const loc = (it.location || '').trim();
    const cur = (it.currency || '').trim().toUpperCase();
    const url = String(it.url || '');

    const locOK = loc && UK_LOCATION_RE.test(loc);
    const curOK = cur === 'GBP';
    const tldOK = UK_TLD_RE.test(url);
    const fbOK = it.source === 'facebook'; // already geo-filtered via ScrapingBee country_code=gb

    return locOK || curOK || tldOK || fbOK;
  });

  // If we over-filtered to 0, fall back to original items (and log)
  if (kept.length === 0) {
    console.info('ℹ️ Region filter would remove all items — returning unfiltered set.');
    return items;
  }

  return kept;
}
