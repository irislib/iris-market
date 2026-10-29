const normalize=(text:string)=>text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ')
const stop=new Set(['a','an','the','and','or','for','with','to','in','on','at','of','from','by','my','i','want','looking','find','show','please'])
export function literalKeywords(query:string):string[]{return [...new Set(normalize(query).split(' ').filter(word=>word&&!stop.has(word)))]}
export function matchesLiteralSearch(text:string,query:string):boolean {
 const phrase=normalize(query);if(!phrase)return true
 const haystack=normalize(text);if(` ${haystack} `.includes(` ${phrase} `))return true
 const words=literalKeywords(query),available=new Set(haystack.split(' '))
 return words.length>0&&words.every(word=>available.has(word))
}
export function listingSearchText(l:{title?:string;description?:string;category?:string;tags?:readonly string[];location?:string}):string{return [l.title,l.description,l.category,...(l.tags||[]),l.location].filter(Boolean).join(' ')}
export function keywordSearches(query:string):string[]{
 const phrase=query.trim().slice(0,500);if(!phrase)return[]
 return [...new Set([phrase,...literalKeywords(query)])].slice(0,4)
}
