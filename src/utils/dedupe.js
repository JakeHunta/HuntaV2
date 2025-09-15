// src/utils/dedupe.js
export function dedupeByUrlPath(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    try {
      const u = new URL(it.url);
      const key = `${u.origin}${u.pathname}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    } catch {
      out.push(it);
    }
  }
  return out;
}
