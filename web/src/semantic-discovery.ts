import {assetUrl} from './asset-url.ts'
import {keywordSearches,literalKeywords} from './lexical-search.ts'

const stride=48 // 384 MiniLM dimensions, one sign bit per dimension.
const u32Stride=stride/4
const stopWords=new Set(['a','an','the','and','or','for','with','to','in','on','at','of','from','by','near','under','over','my','me','i','want','looking','find','show','please','need','something','someone','that','this','is','are','without','can','you','do','have','where','way'])

function pop32(v:number){
  v=v-((v>>>1)&0x55555555)
  v=(v&0x33333333)+((v>>>2)&0x33333333)
  return (((v+(v>>>4))&0x0f0f0f0f)*0x01010101)>>>24
}

/** Light English plural/singular fallback only when the exact form is outside the 9k vocabulary. */
export function lookupTopicWord(word:string,positions:Map<string,number>):number|undefined{
  const exact=positions.get(word)
  if(exact!==undefined)return exact
  if(word.length>4&&word.endsWith('ies')){const p=positions.get(word.slice(0,-3)+'y');if(p!==undefined)return p}
  if(word.length>3&&word.endsWith('s')&&!word.endsWith('ss')){const p=positions.get(word.slice(0,-1));if(p!==undefined)return p}
  if(word.length>4&&/(?:ch|sh|x|z|s|o)es$/.test(word)){const p=positions.get(word.slice(0,-2));if(p!==undefined)return p}
  return undefined
}

function buildIndex(bytes:Uint8Array){
  const separator=bytes.indexOf(0)
  const words=new TextDecoder().decode(bytes.subarray(0,separator)).split('\n')
  const rawVectors=bytes.subarray(separator+1)
  if(separator<0||words.length!==9000||rawVectors.length!==words.length*stride)throw Error('Invalid topic index')
  // Copy into an aligned buffer so 32-bit XOR + SWAR popcount works on any byteOffset.
  const aligned=new Uint8Array(rawVectors.length)
  aligned.set(rawVectors)
  const vectors=new Uint32Array(aligned.buffer)
  const positions=new Map(words.map((word,i)=>[word,i]))
  const hamming=(a:number,b:number)=>{
    let d=0
    for(let k=0;k<u32Stride;k++)d+=pop32(vectors[a+k]^vectors[b+k])
    return d
  }
  const select=(query:string,observed:readonly string[])=>{
    const text=query.normalize('NFKC').trim().toLowerCase()
    const tokens:string[]=text.match(/[\p{L}\p{N}]+/gu)??[]
    const significant=new Set(tokens.length===1?tokens:literalKeywords(text))
    const resolved=new Set<number>()
    for(const w of significant){const p=lookupTopicWord(w,positions);if(p!==undefined)resolved.add(p)}
    // Tokenizer order approximates word frequency. Give specific vocabulary
    // more weight and bound the work for long requests.
    const focus=[...resolved].sort((a,b)=>b-a).slice(0,8)
      .map((i,_,known)=>({offset:i*u32Stride,weight:known.length===1?1:Math.log2(2+i)}))
    const total=focus.reduce((sum,word)=>sum+word.weight,0)
    const direct=new Set(keywordSearches(text))
    const specificity=(word:string)=>lookupTopicWord(word,positions)??words.length
    const searchable=(word:string)=>word.length>=3&&/\p{L}/u.test(word)&&significant.has(word)
    const phrases:{term:string;weight:number;unsearched:boolean}[]=[]
    for(let i=1;i<tokens.length;i++){
      const left=tokens[i-1],right=tokens[i],term=left+' '+right
      if(term.length<=60&&searchable(left)&&searchable(right)&&!direct.has(term))
        phrases.push({term,weight:specificity(left)+specificity(right),unsearched:!direct.has(left)||!direct.has(right)})
    }
    phrases.sort((a,b)=>b.weight-a.weight)
    // Mean sign agreement measures how close a suggestion is to the query
    // words together. The single-word cutoff is the original 134 bits.
    const neighbors=new Map<string,number>()
    const observedMap=new Map<string,number>()
    if(tokens.length!==1){
      for(const tag of observed){
        const lower=tag.toLowerCase(),p=lookupTopicWord(lower,positions)
        if(p!==undefined&&!resolved.has(p))observedMap.set(lower,p)
      }
    }
    const candidates:Iterable<[string,number]>=total
      ?(tokens.length===1?positions.entries():observedMap.entries())
      :[]
    for(const [word,position] of candidates){
      if(significant.has(word)||resolved.has(position))continue
      let weighted=0
      const target=position*u32Stride
      for(const part of focus)weighted+=part.weight*hamming(part.offset,target)
      const distance=weighted/total
      if(distance<=134)neighbors.set(word,distance)
    }
    const distanceOf=(tag:string)=>{
      const lower=tag.toLowerCase()
      const exact=neighbors.get(lower)
      if(exact!==undefined)return exact
      const p=lookupTopicWord(lower,positions)
      return p!==undefined?neighbors.get(words[p]):undefined
    }
    const tags=observed.filter(tag=>distanceOf(tag)!==undefined)
      .sort((a,b)=>distanceOf(a)-distanceOf(b)).slice(0,4)
    // When a plural single-word query fell back to its singular stem, include that stem for relay search too.
    const stemTerms=tokens.length===1
      ?[...resolved].map(i=>words[i]).filter(w=>!direct.has(w))
      :[]
    // For a compound request only add semantic terms sellers have actually
    // published. Keep phrase probes verbatim instead of synthesizing phrases.
    const related=tokens.length===1
      ?[...stemTerms,...[...neighbors].sort((a,b)=>a[1]-b[1]).map(([word])=>word)]
      :tags.map(tag=>tag.toLowerCase())
    const unsearched=phrases.filter(p=>p.unsearched)
    const probes=unsearched.length?unsearched:phrases.slice(0,1)
    const terms=[...new Set([...probes.map(p=>p.term),...related])].slice(0,2)
    return {tags,terms}
  }
  const wordCache=new WeakMap<object,{offsets:number[];stems:Set<string>}>()
  const stemWord=(w:string)=>w.length>4&&w.endsWith('ies')?w.slice(0,-3)+'y':w.length>4&&/(?:ch|sh|x|z|ss|o)es$/.test(w)?w.slice(0,-2):w.length>3&&w.endsWith('s')&&!/(?:ss|us|is)$/.test(w)?w.slice(0,-1):w
  const listingFeatures=(listing:{title?:string;description?:string;category?:string;tags?:readonly string[]})=>{
    const frozen=Object.isFrozen(listing)&&(!listing.tags||Object.isFrozen(listing.tags))
    if(frozen){const cached=wordCache.get(listing);if(cached)return cached}
    const raw=`${listing.title??''} ${(listing.description??'').slice(0,300)} ${listing.category??''} ${(listing.tags??[]).slice(0,8).join(' ')}`
    const toks=raw.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]
    const offsets:number[]=[],seen=new Set<number>(),stems=new Set<string>()
    for(const w of toks){
      if(w.length<2||stopWords.has(w))continue
      stems.add(w);stems.add(stemWord(w))
      if(w.length>=3&&offsets.length<24){
        const p=lookupTopicWord(w,positions)
        if(p!==undefined&&!seen.has(p)){seen.add(p);offsets.push(p*u32Stride)}
      }
    }
    const features={offsets,stems}
    if(frozen)wordCache.set(listing,features)
    return features
  }
  /** Fast semantic tie-breaker to review likely matches first without excluding any listing. */
  const scoreListing=(query:string,listing:{title?:string;description?:string;category?:string;tags?:readonly string[]}):number=>{
    const toks=(query.normalize('NFKC').trim().toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).filter(w=>w.length>=2&&!stopWords.has(w))
    const qOffsets:number[]=[],qSeen=new Set<number>()
    for(const w of toks){
      const p=lookupTopicWord(w,positions)
      if(p!==undefined&&!qSeen.has(p)){qSeen.add(p);qOffsets.push(p*u32Stride);if(qOffsets.length>=8)break}
    }
    if(!qOffsets.length)return 0
    const {offsets:lOffsets}=listingFeatures(listing)
    if(!lOffsets.length)return 0
    let sum=0
    for(const qOff of qOffsets){
      let best=384
      for(const lOff of lOffsets){const d=hamming(qOff,lOff);if(d<best)best=d}
      sum+=Math.max(0,1-best/192)
    }
    return sum/qOffsets.length
  }
  const prioritize=<T extends {title?:string;description?:string;category?:string;tags?:readonly string[]}>(query:string,listings:readonly T[]):T[]=>{
    if(listings.length<2)return [...listings]
    const toks=[...new Set((query.normalize('NFKC').trim().toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).filter(w=>w.length>=2&&!stopWords.has(w)))]
    const qStems=toks.map(stemWord)
    const qOffsets:number[]=[],qSeen=new Set<number>()
    for(const w of toks){
      const p=lookupTopicWord(w,positions)
      if(p!==undefined&&!qSeen.has(p)){qSeen.add(p);qOffsets.push(p*u32Stride);if(qOffsets.length>=8)break}
    }
    if(!qOffsets.length&&!qStems.length)return [...listings]
    // Keep direct/stemmed matches first, then surface semantically closest candidates ahead of unrelated items.
    const scored=listings.map((item,index)=>{
      const {offsets:lOffsets,stems:lStems}=listingFeatures(item)
      const lex=qStems.length?qStems.filter(s=>lStems.has(s)).length/qStems.length:0
      let sem=0
      if(qOffsets.length&&lOffsets.length){
        let sum=0
        for(const qOff of qOffsets){
          let best=384
          for(const lOff of lOffsets){const d=hamming(qOff,lOff);if(d<best)best=d}
          sum+=Math.max(0,1-best/192)
        }
        sem=sum/qOffsets.length
      }
      return {item,key:lex+.8*sem-index*1e-4}
    })
    scored.sort((a,b)=>b.key-a.key)
    return scored.map(row=>row.item)
  }
  return {select,scoreListing,prioritize}
}

export function readTopicVectors(bytes:Uint8Array){
  const index=buildIndex(bytes)
  return Object.assign(index.select,{scoreListing:index.scoreListing,prioritize:index.prioritize})
}

let loading:Promise<ReturnType<typeof buildIndex>>|undefined
let loadedIndex:ReturnType<typeof buildIndex>|undefined

function loadIndex(){
  loading??=fetch(assetUrl('topic-vectors.bin')).then(async response=>{
    if(!response.ok)throw Error('Topic index unavailable')
    const data=await response.arrayBuffer()
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('')
    if(hash!=='511a0f9e0546d2904e056310c025af076fec71cf4906b6ef50e1272eae1aea24')throw Error('Topic index failed verification')
    return loadedIndex=buildIndex(new Uint8Array(data))
  }).catch(error=>{loading=undefined;throw error})
  return loading
}

/** Non-blocking semantic ordering for unreviewed AI search candidates using the already-verified topic index. */
export function prioritizeSemanticCandidates<T extends {title?:string;description?:string;category?:string;tags?:readonly string[]}>(query:string,listings:readonly T[]):T[]{
  if(!query.trim()||listings.length<2)return [...listings]
  if(!loadedIndex){if(typeof fetch==='function')void loadIndex().catch(()=>{});return [...listings]}
  return loadedIndex.prioritize(query,listings)
}

export async function planTopicFilters(query:string,tags:readonly string[],signal:AbortSignal){
  if(signal.aborted||query.length>500||!/\p{L}/u.test(query))return {tags:[],terms:[]}
  const index=await loadIndex()
  return signal.aborted?{tags:[],terms:[]}:index.select(query,tags)
}
