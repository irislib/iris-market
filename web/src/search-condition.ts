// A bare word is a topic; longer searches retain the user's intent.
export function searchCondition(value) {
  const query = String(value ?? '').trim().slice(0, 500);
  return /^[\p{L}\p{N}_-]+$/u.test(query) ? `This listing is about ${query}.` : `This listing matches this search: ${query}`;
}
export function listingSearchText(listing) {
  return `${listing.side === 'request' ? 'Wanted' : 'Offered'}: ${listing.title}\n${listing.description}\nCategory: ${listing.category}\nLocation: ${listing.location}\nPrice: ${listing.price} ${listing.currency}`.slice(0, 2000);
}
