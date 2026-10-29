import type {Event as NostrEvent} from 'nostr-tools/pure'

const DATABASE='iris-market-public-listings-v1'
const DISABLED_KEY=`${DATABASE}:unavailable`
const MAX_RECORDS=1000
const MAX_EVENT_BYTES=65536
interface ListingKey {id:string;createdAt:number;eventId:string}
type Validate=(event:NostrEvent)=>ListingKey
export interface PublicListingCache {
  load():Promise<NostrEvent[]>;
  save(event:NostrEvent):void;
  flush():Promise<void>;
}
export interface ListingCacheBackend {
  read(limit:number):Promise<NostrEvent[]>;
  write(events:readonly NostrEvent[],limit:number,validate:Validate):Promise<void>;
}
interface CacheOptions {backend:ListingCacheBackend;validate:Validate;maxRecords?:number;storage?:Pick<Storage,'getItem'|'setItem'>;onUnavailable?:()=>void}
const wire=(event:NostrEvent):NostrEvent=>({id:event.id,pubkey:event.pubkey,kind:event.kind,created_at:event.created_at,tags:event.tags.map(tag=>[...tag]),content:event.content,sig:event.sig})
const newer=(next:ListingKey,old:ListingKey)=>next.createdAt>old.createdAt||(next.createdAt===old.createdAt&&next.eventId<old.eventId)

/** Public signed records only. Winning sold/expired revisions occupy their slots
 * permanently; capacity never makes an older listing visible again. */
export function createPublicListingCache({backend,validate,maxRecords=MAX_RECORDS,storage,onUnavailable=()=>{}}:CacheOptions):PublicListingCache {
  if(!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>MAX_RECORDS)throw new Error('Invalid offline listing capacity')
  const records=new Map<string,{event:NostrEvent;key:ListingKey}>(),pending=new Map<string,NostrEvent>()
  let unavailable=false,loaded=false,initial:Promise<void>|null=null,writing:Promise<void>|null=null
  function disable(){
    if(unavailable)return
    unavailable=true;records.clear();pending.clear()
    // Fail closed after a quota/write failure: an old active revision must not
    // reappear offline if its newer sold/expired revision could not be saved.
    try{storage?.setItem(DISABLED_KEY,'1')}catch{/* Storage itself is unavailable. */}
    onUnavailable()
  }
  function checked(input:NostrEvent){
    const event=wire(input)
    if(event.kind!==30402||new TextEncoder().encode(JSON.stringify(event)).length>MAX_EVENT_BYTES)throw new Error('Invalid offline listing')
    return{event,key:validate(event)}
  }
  function initialize(){
    if(!initial)initial=(async()=>{
      try{
        if(storage?.getItem(DISABLED_KEY)==='1'){unavailable=true;return}
        const events=await backend.read(maxRecords+1)
        if(events.length>maxRecords)throw new Error('Offline listing capacity exceeded')
        for(let i=0;i<events.length;i++){
          // Persisted wire data is untrusted; reverify its signature and fields.
          const item=checked(events[i]),old=records.get(item.key.id)
          if(!old||newer(item.key,old.key))records.set(item.key.id,item)
          if(i%32===31)await new Promise(resolve=>setTimeout(resolve,0))
        }
        loaded=true
      }catch{disable()}
    })()
    return initial
  }
  async function drain(){
    await initialize()
    while(!unavailable&&pending.size){
      const batch:NostrEvent[]=[]
      for(const event of pending.values()){
        const key=validate(event),old=records.get(key.id)
        if((old||records.size<maxRecords)&&(!old||newer(key,old.key))){records.set(key.id,{event,key});batch.push(event)}
      }
      pending.clear()
      try{
        if(batch.length)await backend.write(batch,maxRecords,validate)
      }catch{disable()}
    }
  }
  function flush(){
    if(!writing)writing=drain().finally(()=>{writing=null;if(pending.size&&!unavailable)void flush()})
    return writing
  }
  return{
    async load(){await initialize();return unavailable?[]:[...records.values()].map(item=>wire(item.event))},
    save(input){
      if(unavailable)return
      let item:ReturnType<typeof checked>;try{item=checked(input)}catch{return}
      const old=pending.get(item.key.id),known=records.get(item.key.id)
      if(old&&!newer(item.key,validate(old))||!old&&known&&!newer(item.key,known.key))return
      if(loaded&&!known&&records.size>=maxRecords)return
      if(!old&&pending.size>=maxRecords){disable();return}
      pending.set(item.key.id,item.event);void flush()
    },
    async flush(){do{await flush()}while(writing||pending.size)},
  }
}

function indexedBackend(indexedDB:IDBFactory):ListingCacheBackend {
  let opening:Promise<IDBDatabase>|null=null
  function open(){
    if(!opening)opening=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DATABASE,1)
      request.onupgradeneeded=()=>{request.result.createObjectStore('listings',{keyPath:'coordinate'})}
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db)}
      request.onerror=()=>reject(request.error)
      request.onblocked=()=>reject(new Error('Offline listing storage is busy'))
    })
    return opening
  }
  return{
    async read(limit){
      const db=await open()
      return new Promise((resolve,reject)=>{
        const transaction=db.transaction('listings','readonly'),request=transaction.objectStore('listings').getAll(undefined,limit)
        transaction.oncomplete=()=>resolve(request.result.map(record=>record.event))
        transaction.onerror=transaction.onabort=()=>reject(transaction.error??request.error)
      })
    },
    async write(events,limit,validate){
      const db=await open()
      return new Promise((resolve,reject)=>{
        const transaction=db.transaction('listings','readwrite'),store=transaction.objectStore('listings'),count=store.count()
        transaction.oncomplete=()=>resolve()
        transaction.onerror=transaction.onabort=()=>reject(transaction.error??new Error('Offline listing write failed'))
        count.onsuccess=()=>{
          let size=count.result
          // One transaction serializes competing tabs and rechecks the winning
          // revision inside storage, so neither tab can overwrite a tombstone.
          for(const event of events){
            const key=validate(event),request=store.get(key.id)
            request.onsuccess=()=>{
              try{
                const old=request.result?.event,previous=old?validate(wire(old)):null
                if(previous&&!newer(key,previous)||!previous&&size>=limit)return
                if(!previous)size++
                store.put({coordinate:key.id,event:wire(event)})
              }catch{transaction.abort()}
            }
          }
        }
      })
    },
  }
}
let shared:PublicListingCache|null=null
/** Public inventory has its own database. No profile keys, chats, tokens, drafts,
 * search terms, uploads or private responses enter this cache. */
export function publicListingCache(validate:Validate):PublicListingCache|null {
  if(!globalThis.indexedDB)return null
  if(!shared){
    let storage:Storage|undefined;try{storage=globalThis.localStorage}catch{return null}
    shared=createPublicListingCache({backend:indexedBackend(globalThis.indexedDB),validate,storage})
  }
  return shared
}
