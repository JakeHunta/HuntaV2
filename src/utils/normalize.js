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
    // accept items with price OR image (FB/CC often omit one)
    __ok: !!(url && title && (price || image)),
  };
}
