import {assetUrl} from './asset-url.ts'
import {keywordSearches,literalKeywords} from './lexical-search.ts'

const stride=48 // 384 MiniLM dimensions, one sign bit per dimension.
const popcount=Uint8Array.from({length:256},(_,value)=>{
  let count=0
  for(let bits=value;bits;bits&=bits-1)count++
  return count
})

export function readTopicVectors(bytes:Uint8Array){
  const separator=bytes.indexOf(0)
  const words=new TextDecoder().decode(bytes.subarray(0,separator)).split('\n')
  const vectors=bytes.subarray(separator+1)
  if(separator<0||words.length!==9000||vectors.length!==words.length*stride)throw Error('Invalid topic index')
  const positions=new Map(words.map((word,i)=>[word,i]))
  return (query:string,observed:readonly string[])=>{
    const text=query.normalize('NFKC').trim().toLowerCase()
    const tokens:string[]=text.match(/[\p{L}\p{N}]+/gu)??[]
    const significant=new Set(tokens.length===1?tokens:literalKeywords(text))
    // Tokenizer order approximates word frequency. Give specific vocabulary
    // more weight and bound the work for long requests.
    const focus=[...significant].filter(w=>positions.has(w))
      .map(w=>positions.get(w)).sort((a,b)=>b-a).slice(0,8)
      .map((i,_,known)=>({offset:i*stride,weight:known.length===1?1:Math.log2(2+i)}))
    const total=focus.reduce((sum,word)=>sum+word.weight,0)
    const direct=new Set(keywordSearches(text))
    const specificity=(word:string)=>positions.get(word)??words.length
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
    const candidates=tokens.length===1?words:new Set(observed.map(tag=>tag.toLowerCase()))
    for(const word of total?candidates:[]){
      const position=positions.get(word)
      if(position===undefined||significant.has(word))continue
      let weighted=0
      for(const part of focus){
        let difference=0
        for(let k=0;k<stride;k++)difference+=popcount[vectors[part.offset+k]^vectors[position*stride+k]]
        weighted+=part.weight*difference
      }
      const distance=weighted/total
      if(distance<=134)neighbors.set(word,distance)
    }
    const tags=observed.filter(tag=>neighbors.has(tag.toLowerCase()))
      .sort((a,b)=>neighbors.get(a.toLowerCase())-neighbors.get(b.toLowerCase())).slice(0,4)
    // For a compound request only add semantic terms sellers have actually
    // published. Keep phrase probes verbatim instead of synthesizing phrases.
    const related=tokens.length===1
      ?[...neighbors].sort((a,b)=>a[1]-b[1]).map(([word])=>word)
      :tags.map(tag=>tag.toLowerCase())
    const unsearched=phrases.filter(p=>p.unsearched)
    const probes=unsearched.length?unsearched:phrases.slice(0,1)
    const terms=[...new Set([...probes.map(p=>p.term),...related])].slice(0,2)
    return {tags,terms}
  }
}

let loading:Promise<ReturnType<typeof readTopicVectors>>|undefined
export async function planTopicFilters(query:string,tags:readonly string[],signal:AbortSignal){
  if(signal.aborted||query.length>500||!/\p{L}/u.test(query))return {tags:[],terms:[]}
  loading??=fetch(assetUrl('topic-vectors.bin')).then(async response=>{
    if(!response.ok)throw Error('Topic index unavailable')
    const data=await response.arrayBuffer()
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),b=>b.toString(16).padStart(2,'0')).join('')
    if(hash!=='511a0f9e0546d2904e056310c025af076fec71cf4906b6ef50e1272eae1aea24')throw Error('Topic index failed verification')
    return readTopicVectors(new Uint8Array(data))
  }).catch(error=>{loading=undefined;throw error})
  const select=await loading
  return signal.aborted?{tags:[],terms:[]}:select(query,tags)
}
