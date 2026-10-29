import { HashtreeNostrEventReader } from '@hashtree/nostr-pubsub'
import { parseHashtreeRootEvent } from '@hashtree/nostr'
import type { CID, Store } from '@hashtree/core'
import { decode } from 'nostr-tools/nip19'
import { verifyEvent, type Event, type Filter } from 'nostr-tools'
import type { RuntimeSource, RuntimeQueryOptions } from 'nostr-pubsub'
import { MapBlockCache } from './map/cache.ts'
import { CACHE_OPTIONS, DEFAULT_CACHE_MIB } from './map/config.ts'

// Existing public archive supplies profiles/follows. Verified additional Market
// roots can be added here after their separate production publication gate.
export const DEFAULT_PUBLIC_INDEX_REFS = Object.freeze([
  'npub1yscmnnadrmvape0mvgzfx9uyl267klnhzy8znsr6ysl8wtxngpqsnx6dm0/nostr-event-index',
])
const INDEX_KINDS = new Set([0, 3, 5, 7368, 30402, 30405, 30406, 31555])
const ROOT_KINDS = [30064, 30078]
const MAX_QUERY_BYTES = 16 * 1024 * 1024
type RootQuery = (filters: Filter[], options?: RuntimeQueryOptions) => Promise<{events:Event[]}>
interface IndexOptions { queryRoots: RootQuery; store?: Store; refs?: readonly string[]; now?: () => number }
interface RootRecord { event: Event; cid: CID }
const cancelled = () => new DOMException('Public index request cancelled', 'AbortError')

function reference(value: string) {
  const parts=value.split('/'),decoded=decode(parts[0])
  if(parts.length!==2||decoded.type!=='npub'||!/^nostr-(?:event-index|market-reviews-v1-[a-f0-9]{20})$/.test(parts[1])) throw new Error('Invalid public index reference')
  return {ref:value,author:decoded.data,name:parts[1]}
}
function newer(a:Event,b?:Event) { return !b||a.created_at>b.created_at||(a.created_at===b.created_at&&a.id<b.id) }

let cache:MapBlockCache|null=null
/** Same public block database and quota as maps; it contains no profile secrets. */
async function defaultStore():Promise<Store> {
  let mib=DEFAULT_CACHE_MIB
  try { const saved=Number(localStorage.getItem('market-map-cache'));if(CACHE_OPTIONS.includes(saved))mib=saved } catch {}
  if(!cache)cache=new MapBlockCache({cacheMiB:mib})
  else if(cache.maxBytes!==mib*1024*1024)await cache.setCacheMiB(mib)
  const current=cache
  return {get:hash=>current.get(hash),has:hash=>current.store.has(hash),put:async()=>{throw new Error('Public index is read-only')},delete:async()=>false}
}

/** One source shared by the worker and the listing reducer. No second relay pool. */
export function createPublicIndex({queryRoots,store,refs=DEFAULT_PUBLIC_INDEX_REFS,now=()=>Math.floor(Date.now()/1000)}:IndexOptions) {
  if(!Array.isArray(refs)||!refs.length||refs.length>4)throw new Error('Choose one to four public indexes')
  const selected=[...new Set(refs)].map(reference),roots=new Map<string,RootRecord>()
  const pending=new Map<string,Promise<void>>(),refreshed=new Map<string,number>()
  function admit(ref:ReturnType<typeof reference>,events:Event[]) {
    for(const input of events.slice(0,32))try {
      const event={id:input.id,pubkey:input.pubkey,created_at:input.created_at,kind:input.kind,content:input.content,tags:input.tags.map(tag=>[...tag]),sig:input.sig}
      if(!ROOT_KINDS.includes(event.kind)||event.pubkey!==ref.author||!Number.isSafeInteger(event.created_at)||event.created_at>now()+300||JSON.stringify(event).length>16384||!verifyEvent(event))continue
      const parsed=parseHashtreeRootEvent(event)
      if(parsed?.visibility==='public'&&parsed.treeName===ref.name&&event.tags.filter(tag=>tag[0]==='d').length===1&&event.tags.filter(tag=>tag[0]==='hash').length===1&&newer(event,roots.get(ref.ref)?.event))roots.set(ref.ref,{event,cid:parsed.rootCid})
    }catch{/* A malformed pointer cannot replace a verified root. */}
  }
  function refresh(ref:ReturnType<typeof reference>,deadline:number) {
    let task=pending.get(ref.ref)
    if(task)return task
    task=(async()=>{
      const filters=[{kinds:ROOT_KINDS,authors:[ref.author],'#d':[ref.name],limit:16}]
      const cached=await queryRoots(filters,{cache:'cache-only',limit:16,deadline});admit(ref,cached.events)
      if(Date.now()-(refreshed.get(ref.ref)??0)<60000)return
      refreshed.set(ref.ref,Date.now())
      const live=queryRoots(filters,{cache:'network-only',limit:16,deadline}).then(report=>admit(ref,report.events)).catch(()=>{})
      if(!roots.has(ref.ref))await live
    })().catch(()=>{}).finally(()=>pending.delete(ref.ref))
    pending.set(ref.ref,task);return task
  }
  async function query(filters:Filter[],options:RuntimeQueryOptions={}) {
    if(options.signal?.aborted)throw cancelled()
    if(!filters.length||filters.length>64||filters.some(filter=>!filter.kinds?.length||filter.kinds.some(kind=>!INDEX_KINDS.has(kind))))return{events:[],complete:true}
    const deadline=Math.min(options.deadline??Date.now()+6000,Date.now()+10000)
    const work=selected.map(ref=>refresh(ref,Math.min(deadline,Date.now()+2500)))
    // Cached roots are immediately usable; a fresh lookup runs in the background.
    if(!selected.every(ref=>roots.has(ref.ref)))await Promise.race([Promise.all(work),new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(done,Math.max(0,deadline-Date.now()))
      function done(){clearTimeout(timer);options.signal?.removeEventListener('abort',abort);resolve()}
      function abort(){clearTimeout(timer);options.signal?.removeEventListener('abort',abort);reject(cancelled())}
      options.signal?.addEventListener('abort',abort,{once:true})
      void Promise.all(work).then(done)
    })])
    if(options.signal?.aborted)throw cancelled()
    const entries=selected.flatMap(ref=>{const record=roots.get(ref.ref);return record?[{partitionId:ref.ref,root:record.cid}]:[]})
    if(!entries.length)return{events:[],complete:false}
    const backing=store??await defaultStore();let bytes=0,blocks=0
    const bounded:Store={...backing,get:async hash=>{
      if(options.signal?.aborted)throw cancelled()
      if(++blocks>2048)throw new Error('Public index read exceeded its block budget')
      const value=await backing.get(hash);bytes+=value?.byteLength??0
      if(bytes>MAX_QUERY_BYTES)throw new Error('Public index read exceeded its byte budget')
      return value
    },has:hash=>backing.has(hash),put:async()=>{throw new Error('Public index is read-only')},delete:async()=>false}
    const reader=new HashtreeNostrEventReader({store:bounded,roots:entries,sourceId:'iris-market-public-index',maxConcurrentPartitions:1})
    const result=await reader.query(filters,{signal:options.signal,deadline,limit:Math.min(1024,options.limit??1024)})
    return {...result,complete:result.complete&&entries.length===selected.length}
  }
  // The worker's MessagePort bridge advertises subscribe for every source.
  // Supply an idle live stream so its historical query is still attached.
  const source:RuntimeSource={id:'iris-market-public-index',query,subscribe:()=>({close(){}})}
  return {source,query}
}
