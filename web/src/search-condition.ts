// A bare word is a topic; longer searches retain the user's full intent.
export const isTopicSearch = value => /^[\p{L}\p{N}_-]+$/u.test(String(value ?? '').trim());
export function searchCondition(value) {
  const query = String(value ?? '').trim().slice(0, 500);
  return isTopicSearch(query) ? `This text is about ${query}.` : `This listing matches this search: ${query}`;
}
export function listingSearchText(listing) {
  return `${listing.side === 'request' ? 'Wanted' : 'Offered'}: ${listing.title}\n${listing.description||''}\nCategory: ${listing.category||''}\nLocation: ${listing.location||''}\nPrice: ${listing.price??''} ${listing.currency||''}`.slice(0, 2000);
}
/** Short topic evidence keeps marketing copy from drowning out the actual item.
 * Compound requests always retain the full description, price and location. */
export function listingSearchTexts(listing,query,model='deberta') {
  if(model!=='deberta'||!isTopicSearch(query))return [listingSearchText(listing)];
  const title=String(listing.title??'').slice(0,500);
  const tags=(listing.tags||[listing.category]).filter(value=>typeof value==='string').slice(0,16).join(', ');
  const overview=`${title}\nCategories: ${tags}\n${String(listing.description??'').slice(0,650)}`.slice(0,2000);
  return [...new Set([title,overview].filter(Boolean))];
}
