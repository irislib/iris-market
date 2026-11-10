const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ')
const stop=new Set(['a','an','the','and','or','for','with','to','in','on','at','of','from','by','my','i','want','looking','find','show','please'])
export function literalKeywords(query:string):string[]{return [...new Set(normalize(query).split(' ').filter(word=>word&&!stop.has(word)))]}
// Every listing is compared with the same search, so prepare it once.
let prepared={query:'',phrase:'',words:[] as string[]}
export function matchesLiteralSearch(text:string,query:string):boolean {
 if(query!==prepared.query)prepared={query,phrase:normalize(query),words:literalKeywords(query)}
 const {phrase,words}=prepared;if(!phrase)return true
 const haystack=` ${normalize(text)} `;if(haystack.includes(` ${phrase} `))return true
 return words.length>0&&words.every(word=>haystack.includes(` ${word} `))
}
/** Direct evidence for a single topic, never a shortcut for compound requests. */
export function matchesSingleTermSearch(text:string,query:string):boolean {
 const term=query.normalize('NFKC').trim()
 return /^[\p{L}\p{N}_-]+$/u.test(term)&&/[\p{L}\p{N}]/u.test(term)&&` ${normalize(text)} `.includes(` ${normalize(term)} `)
}
export function listingSearchText(l:{title?:string;description?:string;category?:string;tags?:readonly string[];location?:string}):string{return [l.title,l.description,l.category,...(l.tags||[]),l.location].filter(Boolean).join(' ')}
type SearchableListing=Parameters<typeof listingSearchText>[0]
// Verified listings are immutable, so their match for the active search is
// decided once instead of normalizing every description on each render.
let matchedQuery=''
let matched=new WeakMap<SearchableListing,boolean>()
export function listingMatchesLiteralSearch(listing:SearchableListing,query:string):boolean {
 if(!Object.isFrozen(listing)||!Object.isFrozen(listing.tags))return matchesLiteralSearch(listingSearchText(listing),query)
 if(query!==matchedQuery){matchedQuery=query;matched=new WeakMap()}
 let result=matched.get(listing)
 if(result===undefined)matched.set(listing,result=matchesLiteralSearch(listingSearchText(listing),query))
 return result
}
export function keywordSearches(query:string):string[]{
 const phrase=query.trim().slice(0,500);if(!phrase)return[]
 return [...new Set([phrase,...literalKeywords(query)])].slice(0,4)
}
