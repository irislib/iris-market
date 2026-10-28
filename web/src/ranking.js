// Marketplace ranking uses public graph evidence and this browser's saved interests.
// Unknown authors remain eligible. Scores are never a statement about identity.
const DAY = 86400;
const text = value => String(value ?? '').trim().toLowerCase();
const finite = value => Number.isFinite(value) ? value : 0;
export function rankListings(listings, { relationFor = () => null, saved = new Set(), savedListings = listings, query = '', now = Date.now() / 1000 } = {}) {
  const interests = new Map();
  for (const listing of savedListings) if (saved.has(listing.id)) {
    const category = text(listing.category);
    if (category && category !== 'other') interests.set(category, (interests.get(category) || 0) + 1);
  }
  const terms = text(query).split(/\s+/u).filter(Boolean);
  const scored = listings.map(listing => {
    const relation = relationFor(listing.author);
    const distance = relation?.distance;
    const trust = distance === 0 || distance === 1 ? 8 : distance === 2 ? 4 : distance === 3 ? 2 : 0;
    const known = Math.min(2, Math.log2(1 + Math.max(0, finite(relation?.knownFollowerCount))));
    const age = Math.max(0, now - finite(listing.createdAt));
    const freshness = 4 * Math.pow(0.5, age / (14 * DAY));
    const interest = Math.min(3, interests.get(text(listing.category)) || 0);
    const title = text(listing.title);
    const relevance = terms.length ? 2 * terms.filter(term => title.includes(term)).length / terms.length : 0;
    return { listing, score: trust + known + freshness + interest + relevance };
  }).sort((a, b) => b.score - a.score || finite(b.listing.createdAt) - finite(a.listing.createdAt) || String(a.listing.id).localeCompare(String(b.listing.id)));
  const output = [], authors = new Map();
  while (scored.length) {
    let best = 0, bestScore = -Infinity;
    for (let index = 0; index < scored.length; index++) {
      const { listing, score } = scored[index];
      const adjusted = score - 6 * (authors.get(listing.author) || 0);
      if (adjusted > bestScore) { best = index; bestScore = adjusted; }
      // Remaining base scores are lower, and diversity penalties are nonnegative.
      if (score < bestScore) break;
    }
    const [{ listing }] = scored.splice(best, 1);
    output.push(listing);
    authors.set(listing.author, (authors.get(listing.author) || 0) + 1);
  }
  return output;
}
