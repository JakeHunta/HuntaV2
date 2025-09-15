// Dedupe using URL origin + pathname (stable for FB item IDs, etc.)
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
      out.push(it); // if URL parsing fails, keep rather than over-drop
    }
  }
  return out;
}
