// src/aggregate/mergeResults.js
import { normalizeListing } from "../utils/normalize.js";
import { dedupeByUrlPath } from "../utils/dedupe.js";
import { filterByRegion } from "../filters/regionFilter.js";

export function mergeResults(sourceArrays, { maxResults = 100, region = 'UK' } = {}) {
  const merged = sourceArrays.flat().map(normalizeListing).filter(Boolean);

  const dropStats = { missingCore: 0 };
  const kept = [];
  for (const it of merged) {
    if (!it.__ok) { dropStats.missingCore++; continue; }
    kept.push(it);
  }

  const deduped = dedupeByUrlPath(kept);
  const regioned = filterByRegion(deduped, region);
  const final = regioned.slice(0, maxResults);

  console.info(
    `🧪 merge: in=${merged.length} dropped=${dropStats.missingCore} ` +
    `deduped=${deduped.length} regionKept=${regioned.length} final=${final.length}`
  );

  return final;
}
