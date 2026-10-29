// A bare word is a topic; longer searches retain the user's full intent.
export const isTopicSearch = value => /^[\p{L}\p{N}_-]+$/u.test(String(value ?? '').trim());
export function searchCondition(value,model='deberta') {
  const query = String(value ?? '').trim().slice(0, 500);
  if(isTopicSearch(query))return `This text is about ${query}.`;
  // NLI needs a concrete proposition, rather than a statement about a search.
  // Keep the query intact; this is the same template for every subject.
  return model==='deberta'?`This listing offers ${query}.`:`This listing matches this search: ${query}`;
}
export function listingSearchText(listing) {
  const title=String(listing.title??'').trim().slice(0,500);
  const heading=listing.side==='request'?`Wanted: ${title}`:listing.side==='offer'?`Offered: ${title}`:title;
  const metadata=[];
  for(const [label,value] of [['Category',listing.category],['Location',listing.location]]){
    if(value!==undefined&&value!==null&&String(value).trim())metadata.push(`${label}: ${String(value).trim()}`);
  }
  const price=listing.price===undefined||listing.price===null?'':String(listing.price).trim();
  if(price)metadata.push(`Price: ${price}${listing.currency&&String(listing.currency).trim()?` ${String(listing.currency).trim()}`:''}`);
  // Reserve room for real constraints before bounding a long description.
  const fixed=[heading,...metadata].filter(Boolean).join('\n');
  const description=String(listing.description??'').trim().slice(0,Math.max(0,2000-fixed.length-1));
  return [heading,description,...metadata].filter(Boolean).join('\n').slice(0,2000);
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
