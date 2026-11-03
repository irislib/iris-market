import {assetUrl} from './asset-url.ts'

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
    const word=query.normalize('NFKC').trim().toLowerCase(),position=positions.get(word)
    if(position===undefined)return {tags:[],terms:[]}
    const distance=(i:number,j:number)=>{
      let different=0
      for(let k=0;k<stride;k++)different+=popcount[vectors[i*stride+k]^vectors[j*stride+k]]
      return different
    }
    // Sign agreement estimates cosine similarity. Keep only neighbors within
    // the equivalent of 0.45 cosine, and preserve exact on-wire tag spelling.
    const neighbors=new Map<string,number>()
    for(let i=0;i<words.length;i++){
      if(i===position)continue
      const d=distance(position,i)
      if(d<=134)neighbors.set(words[i],d)
    }
    const tags=observed.flatMap(tag=>{
      const d=neighbors.get(tag.toLowerCase())
      return d===undefined?[]:[{tag,d}]
    }).sort((a,b)=>a.d-b.d).slice(0,4).map(t=>t.tag)
    const terms=[...neighbors].sort((a,b)=>a[1]-b[1]).slice(0,2).map(([term])=>term)
    return {tags,terms}
  }
}

let loading:Promise<ReturnType<typeof readTopicVectors>>|undefined
export async function planTopicFilters(query:string,tags:readonly string[],signal:AbortSignal){
  if(signal.aborted||!/^\p{L}+$/u.test(query.trim()))return {tags:[],terms:[]}
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
