import type {Event as NostrEvent} from 'nostr-tools/pure';

const KEY='iris-market-profile-heads-v1';
export const PROFILE_CACHE_LIMITS=Object.freeze({records:512,bytes:2*1024*1024,eventBytes:65536});
type StorageLike=Pick<Storage,'getItem'|'setItem'>;
type Validate=(input:NostrEvent)=>NostrEvent;
const newer=(a:NostrEvent,b?:NostrEvent)=>!b||a.created_at>b.created_at||a.created_at===b.created_at&&a.id<b.id;
const bytes=(value:string)=>new TextEncoder().encode(value).length;
const wire=(e:NostrEvent):NostrEvent=>({id:e.id,pubkey:e.pubkey,kind:e.kind,created_at:e.created_at,tags:e.tags.map(tag=>[...tag]),content:e.content,sig:e.sig});

/** Small signed-head mirror for first paint. The worker remains the durable
 * event store. No unsigned name/avatar projection is accepted from storage. */
export function createProfileHeadCache({storage,validate}:{storage:StorageLike;validate:Validate}) {
  const records=new Map<string,NostrEvent>(),verified=new WeakSet<NostrEvent>(),sizes=new Map<string,number>();let initialized=false,dirty=false,totalBytes=0;
  function discard(key:string){totalBytes-=sizes.get(key)??0;sizes.delete(key);records.delete(key);}
  function retain(event:NostrEvent){discard(event.pubkey);const size=bytes(JSON.stringify(event));sizes.set(event.pubkey,size);totalBytes+=size;records.set(event.pubkey,event);}
  function trim(){while(records.size>PROFILE_CACHE_LIMITS.records||totalBytes>PROFILE_CACHE_LIMITS.bytes-1024)discard(records.keys().next().value);}
  function initialize(){
    if(initialized)return;initialized=true;
    try{
      const raw=storage.getItem(KEY);if(!raw||raw.length>PROFILE_CACHE_LIMITS.bytes||bytes(raw)>PROFILE_CACHE_LIMITS.bytes)return;
      const stored=JSON.parse(raw);if(stored?.version!==1||!Array.isArray(stored.events)||stored.events.length>PROFILE_CACHE_LIMITS.records)return;
      for(const event of stored.events)if(event?.kind===0&&typeof event.pubkey==='string'&&/^[0-9a-f]{64}$/.test(event.pubkey))retain(event);
      trim();
    }catch{/* Inaccessible or malformed storage cannot prevent live metadata. */}
  }
  function checked(input:NostrEvent){
    const event=wire(input);if(event.kind!==0||bytes(JSON.stringify(event))>PROFILE_CACHE_LIMITS.eventBytes)throw Error('Invalid cached profile');
    return validate(event);
  }
  function read(pubkey:string):NostrEvent|null {
    initialize();const event=records.get(pubkey);if(!event)return null;
    try{
      if(!verified.has(event)){checked(event);verified.add(event);}
      records.delete(pubkey);records.set(pubkey,event);return wire(event);
    }catch{discard(pubkey);dirty=true;return null;}
  }
  function observe(input:NostrEvent){
    initialize();const event=checked(input),old=read(event.pubkey);if(!newer(event,old??undefined))return false;
    retain(event);verified.add(event);dirty=true;trim();
    return true;
  }
  function flush(){
    if(!dirty)return;dirty=false;
    // Unrequested stored heads remain untrusted until read; rewriting storage
    // does not bypass their per-record signature check.
    const events=[...records.values()];let payload=JSON.stringify({version:1,events});
    while(events.length&&bytes(payload)>PROFILE_CACHE_LIMITS.bytes){events.shift();payload=JSON.stringify({version:1,events});}
    try{storage.setItem(KEY,payload);}catch{/* Quota failure leaves the worker's existing persistence authoritative. */}
  }
  return{read,observe,flush};
}
