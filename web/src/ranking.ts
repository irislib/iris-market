export interface RankableListing {
  id:string;author:string;category?:string;title?:string;description?:string;tags?:readonly string[];createdAt?:number;
  coordinates?:readonly [number,number]|null;locationBounds?:readonly [number,number,number,number]|null;
}
export interface RankingRelation {distance?:number|null;knownFollowerCount?:number}
export interface RankingOptions<T extends RankableListing> {
  relationFor?:(pubkey:string)=>RankingRelation|null;saved?:ReadonlySet<string>;savedListings?:T[];query?:string;now?:number;
  sort?:'suggested'|'social'|'newest';aiScoreFor?:(listing:T)=>number|null|undefined;location?:readonly [number,number]|null;
}
const DAY=86400
const text=(value:unknown,max=2000)=>String(value??'').slice(0,max).normalize('NFKC').trim().toLowerCase()
const finite=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:0
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0
const words=(value:unknown,max=2000)=>text(value,max).match(/[\p{L}\p{N}]+/gu)||[]
const stopWords=new Set(['a','an','the','and','or','for','with','to','in','on','at','of','from','by','near','under','over','my','me','i','want','looking','find','show','please'])
const point=(value:readonly number[]|null|undefined):value is readonly [number,number]=>Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)&&Math.abs(value[0])<=180&&Math.abs(value[1])<=90
function distance(a:readonly [number,number],b:readonly [number,number]){
  const rad=Math.PI/180,lat=(b[1]-a[1])*rad,lon=(b[0]-a[0])*rad
  return 12742*Math.asin(Math.sqrt(Math.min(1,Math.sin(lat/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(lon/2)**2)))
}
function nearby(listing:RankableListing,location:readonly [number,number]|null|undefined){
  if(!point(location)||!point(listing.coordinates))return 0
  let km=distance(location,listing.coordinates),confidence=1
  const box=listing.locationBounds
  if(Array.isArray(box)&&box.length===4&&box.every(Number.isFinite)&&box[0]>=-180&&box[2]<=180&&box[1]>=-90&&box[3]<=90&&box[0]<=box[2]&&box[1]<=box[3]){
    // Geohash centers are approximate. Distance to the cell avoids pretending
    // its center is the address; coarse cells provide little or no local boost.
    const lat=Math.max(box[1],Math.min(box[3],location[1])),lon=Math.max(box[0],Math.min(box[2],location[0]))
    km=Math.min(...[lon,box[0],box[2]].map(value=>distance(location,[value,lat])))
    const uncertainty=distance([box[0],box[1]],[box[2],box[3]])/2
    confidence=Math.max(0,1-uncertainty/100)
  }
  // Missing or far-away coordinates are neutral, never a negative score.
  return 2*Math.max(0,1-km/100)*confidence
}
function lexical(listing:RankableListing,terms:string[]){
  if(!terms.length)return 0
  const title=words(listing.title,300),tags=new Set(words([listing.category,...(listing.tags||[]).slice(0,16)].join(' '),1200)),body=new Set(words(listing.description)),titleSet=new Set(title)
  const coverage=(values:Set<string>)=>terms.filter(term=>values.has(term)).length/terms.length
  const phrase=(` ${title.join(' ')} `).includes(` ${terms.join(' ')} `)?1:0
  return Math.min(1,.65*coverage(titleSet)+.2*coverage(tags)+.1*coverage(body)+.25*phrase)
}
interface Scored<T>{listing:T;score:number;time:number;id:string}
interface AuthorQueue<T>{items:Scored<T>[];index:number;shown:number;score:number}
const byBase=<T>(a:Scored<T>,b:Scored<T>)=>b.score-a.score||b.time-a.time||compare(a.id,b.id)
const byQueue=<T>(a:AuthorQueue<T>,b:AuthorQueue<T>)=>b.score-a.score||byBase(a.items[a.index],b.items[b.index])

/** Public signals only. Graph proximity is evidence, not identity verification. */
export function rankListings<T extends RankableListing>(listings:T[],{relationFor=()=>null,saved=new Set(),savedListings=listings,query='',now=Date.now()/1000,sort='suggested',aiScoreFor=()=>undefined,location}:RankingOptions<T>={}):T[]{
  if(sort==='newest')return [...listings].sort((a,b)=>finite(b.createdAt)-finite(a.createdAt)||compare(a.id,b.id))
  const counts=new Map<string,number>()
  // Stable sampling and capped counts bound the influence of saved interests.
  const examples=savedListings.filter(listing=>saved.has(listing.id)).sort((a,b)=>compare(a.id,b.id)).slice(0,512)
  for(const listing of examples){const category=text(listing.category,80);if(category&&category!=='other')counts.set(category,Math.min(8,(counts.get(category)||0)+1))}
  const interests=new Map([...counts].sort((a,b)=>b[1]-a[1]||compare(a[0],b[0])).slice(0,32))
  const terms=[...new Set(words(query,500).filter(term=>!stopWords.has(term)))].slice(0,16)
  const relations=new Map<string,RankingRelation|null>(),authors=new Map<string,Scored<T>[]>()
  for(const listing of listings){
    if(!relations.has(listing.author)){try{relations.set(listing.author,relationFor(listing.author))}catch{relations.set(listing.author,null)}}
    const relation=relations.get(listing.author),steps=relation?.distance
    const graph=(steps===0||steps===1?2.5:steps===2?1.5:steps===3?.75:0)+Math.min(1.25,Math.log2(1+Math.max(0,finite(relation?.knownFollowerCount)))/4)
    const time=finite(listing.createdAt),freshness=time>0?2.5*Math.pow(.5,Math.max(0,finite(now)-time)/(14*DAY)):0
    const interest=Math.min(1.5,Math.log2(1+(interests.get(text(listing.category,80))||0))*.5)
    const literal=lexical(listing,terms)
    let ai:number|null|undefined;try{ai=aiScoreFor(listing)}catch{/* Inference failures must leave ordinary ranking usable. */}
    const relevance=typeof ai==='number'&&Number.isFinite(ai)&&ai>=0&&ai<=1?(terms.length?.85*ai+.15*literal:ai):literal
    const score=(sort==='social'?8*relevance+16*graph:32*relevance+graph)+freshness+interest+nearby(listing,location)
    const rows=authors.get(listing.author)||[];rows.push({listing,score,time,id:listing.id});authors.set(listing.author,rows)
  }
  // Each author's remaining rows share the same diversity penalty, so only
  // its best row belongs in the heap. This replaces the repeated full scan.
  const heap:AuthorQueue<T>[]=[]
  const push=(entry:AuthorQueue<T>)=>{heap.push(entry);let index=heap.length-1;while(index>0){const parent=(index-1)>>1;if(byQueue(heap[parent],entry)<=0)break;heap[index]=heap[parent];index=parent}heap[index]=entry}
  const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let index=0;heap[0]=last;while(true){const left=index*2+1;if(left>=heap.length)break;const right=left+1,next=right<heap.length&&byQueue(heap[right],heap[left])<0?right:left;if(byQueue(last,heap[next])<=0)break;heap[index]=heap[next];index=next}heap[index]=last}return first}
  for(const items of authors.values()){items.sort(byBase);push({items,index:0,shown:0,score:items[0].score})}
  const output:T[]=[]
  while(heap.length){const entry=pop();output.push(entry.items[entry.index].listing);entry.index++;entry.shown++;if(entry.index<entry.items.length){entry.score=entry.items[entry.index].score-Math.min(3,1.5*entry.shown);push(entry)}}
  return output
}
