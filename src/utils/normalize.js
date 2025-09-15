// src/utils/normalize.js
export function normalizeListing(listing) {
  if (!listing) return null;
  const title = (listing.title || "").trim();
  const url = listing.url;
  if (!title || !url) return null;

  const price = listing.price ?? null;
  const image = listing.image ?? null;

  return {
    ...listing,
    title,
    currency: listing.currency || "GBP",
    location: listing.location || "UK",
    // accept if (URL & title) and (price OR image)
    __ok: !!(url && title && (price || image)),
  };
}
