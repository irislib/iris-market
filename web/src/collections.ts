// Marketplace kind 30405. A collection names listings by stable address, including
// products published by other sellers. A private bookmark is never an input here.
import {verifyEvent, type Event, type EventTemplate, type Filter} from 'nostr-tools';

export const COLLECTION_KIND = 30405;
export const COLLECTION_LIMITS = Object.freeze({members:64, title:160, eventBytes:32768, perProfile:32});
export interface ProductCollection {
  author:string; identifier:string; title:string; members:string[];
  expiration:number|null; event:Event; delivery:'queued'|'published';
}
type Delivery = ProductCollection['delivery'];
type CollectionQuery = (filters:Filter[], options:{signal?:AbortSignal;limit:number;deadline:number;cache:'cache-first'}) =>
  Promise<{events:Event[];complete?:boolean}>;
type Head = {event:Event; addressDelete?:Event; eventDelete?:Event};
const hex = /^[a-f0-9]{64}$/, encoder = new TextEncoder();
const seconds = () => Math.floor(Date.now()/1000);
const bytes = (value:string) => encoder.encode(value).length;
const newer = (event:Event, previous?:Event) => !previous || event.created_at>previous.created_at ||
  event.created_at===previous.created_at && event.id<previous.id;
function requireField(value:unknown, message:string):asserts value {if(!value)throw new Error(message);}
function single(tags:string[][], name:string) {
  const found=tags.filter(tag=>tag[0]===name);
  requireField(found.length<=1 && (!found.length || found[0].length===2),'Invalid collection '+name+'.');
  return found[0]?.[1];
}
function identifier(value:string):boolean {
  return typeof value==='string' && !!value && bytes(value)<=160 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function productAddress(value:string):boolean {
  return typeof value==='string' && value.startsWith('30402:') && hex.test(value.slice(6,70)) &&
    value[70]===':' && identifier(value.slice(71));
}
function isProductTag(tag:string[]):boolean {return tag[0]==='a' && tag[1]?.startsWith('30402:');}
function membersOf(tags:string[][]) {
  const members=[...new Set(tags.filter(isProductTag).map(tag=>tag[1]))];
  requireField(members.length>=1 && members.length<=COLLECTION_LIMITS.members,'Choose between 1 and 64 listings.');
  requireField(members.every(productAddress),'Choose distinct marketplace listings.');
  return members;
}
function validEnvelope(event:EventTemplate, now:number) {
  requireField(Number.isSafeInteger(event.created_at) && event.created_at>=0 && event.created_at<=now+300,'Invalid collection time.');
  requireField(typeof event.content==='string' && event.content.length<=COLLECTION_LIMITS.eventBytes &&
    Array.isArray(event.tags) && event.tags.length<=256 &&
    event.tags.every(tag=>Array.isArray(tag) && tag.length>0 && tag.every(v=>typeof v==='string' && v.length<=COLLECTION_LIMITS.eventBytes)),
    'Invalid collection fields.');
  requireField(bytes(JSON.stringify(event))<=COLLECTION_LIMITS.eventBytes,'Collection is too large.');
}
function verified(input:Event, author:string, now:number) {
  requireField(input && input.pubkey===author && hex.test(author) && hex.test(input.id) &&
    /^[a-f0-9]{128}$/.test(input.sig) && (input.kind===COLLECTION_KIND || input.kind===5),'Invalid collection signature.');
  validEnvelope(input,now);
  // Discard any verification symbol cached on the caller's mutable event object.
  const event={id:input.id,pubkey:input.pubkey,sig:input.sig,kind:input.kind,tags:input.tags.map(tag=>[...tag]),content:input.content,created_at:input.created_at};
  requireField(verifyEvent(event),'Invalid collection signature.');
  return event;
}
function fields(event:EventTemplate) {
  const id=single(event.tags,'d'), title=single(event.tags,'title');
  requireField(event.kind===COLLECTION_KIND && identifier(id),'Invalid collection identifier.');
  const name=title?.trim();
  requireField(name && Array.from(name).length<=COLLECTION_LIMITS.title && !/[\u0000-\u001f\u007f-\u009f]/.test(name),'Give the collection a name of up to 160 characters.');
  const expires=single(event.tags,'expiration'), expiration=expires===undefined?null:Number(expires);
  requireField(expires===undefined || /^\+?\d{1,20}$/.test(expires) && BigInt(expires)<=18446744073709551615n,'Invalid collection expiry.');
  const status=single(event.tags,'status'), visibility=single(event.tags,'visibility');
  requireField((status===undefined || status==='active') && (visibility===undefined || ['on-sale','pre-order'].includes(visibility)),
    'This collection is unavailable.');
  return {identifier:id,title:name,members:membersOf(event.tags),expiration};
}
export function validateCollectionDraft(draft:EventTemplate, author:string, now=seconds()) {
  requireField(hex.test(author),'Sign in to publish a collection.');
  validEnvelope({...draft,pubkey:author,id:'0'.repeat(64),sig:'0'.repeat(128)} as Event,now);
  const productCount=draft.tags.filter(isProductTag).length;
  const {members,expiration}=fields(draft);
  requireField(members.length===productCount,'Each listing can appear only once.');
  requireField(expiration===null || expiration>now,'This collection has expired.');
  return draft;
}
export function parseCollection(input:Event, author=input?.pubkey, now=seconds(), delivery:Delivery='published'):ProductCollection {
  const event=verified(input,author,now), data=fields(event);
  requireField(data.expiration===null || data.expiration>now,'This collection has expired.');
  return {...data,author,event,delivery};
}
const addressOf = (event:Event) => `${COLLECTION_KIND}:${event.pubkey}:${single(event.tags,'d')}`;
function deleted(head:Head) {
  return [head.addressDelete,head.eventDelete].some(event=>event && event.created_at>=head.event.created_at);
}
function admitHead(map:Map<string,Head>, event:Event, cutoff?:number) {
  const d=single(event.tags,'d');
  if(event.kind!==COLLECTION_KIND || !identifier(d))return false;
  const address=addressOf(event), old=map.get(address);
  if(!newer(event,old?.event))return false;
  if(!old && cutoff!==undefined && event.created_at<=cutoff)return false;
  map.delete(address);
  map.set(address,{event,addressDelete:old?.addressDelete});
  return true;
}
function admitDelete(map:Map<string,Head>, event:Event) {
  if(event.kind!==5)return false;
  const addresses=new Set(event.tags.filter(tag=>tag[0]==='a').map(tag=>tag[1]));
  const ids=new Set(event.tags.filter(tag=>tag[0]==='e').map(tag=>tag[1]));
  let changed=false;
  for(const [address,head] of map){
    if(event.pubkey!==head.event.pubkey || event.created_at<head.event.created_at)continue;
    if(addresses.has(address) && newer(event,head.addressDelete)){head.addressDelete=event;changed=true;}
    if(ids.has(head.event.id) && newer(event,head.eventDelete)){head.eventDelete=event;changed=true;}
  }
  return changed;
}

// The public worker stores relay history. Mirror a bounded set of signed winners
// and their signed deletion requests for synchronous profile reads, including expiry
// tombstones which the worker may no longer return. Pending writes stay in the vault.
const publicHeads=new Map<string,Head>();
// An owner can delete a queued event from another device before we've observed its relay copy.
// Keep just the signed deletion request in public storage until the referenced head is known.
const queuedDeletes=new Map<string,Event>();
const storageKey='iris-market-collection-heads-v1', cacheBytes=1024*1024, cacheRecords=256;
let lastPayload:string|null=null, globalFloor:Event|undefined;
const floors=new Map<string,Event>();
// The discarded winner (or its deletion) establishes a signed time boundary.
// This avoids resurrecting a previously evicted coordinate from a stale relay.
function advanceFloor(event:Event) {
  if(newer(event,floors.get(event.pubkey)))floors.set(event.pubkey,event);
}
function cutoff(author:string) {
  return Math.max(floors.get(author)?.created_at??-1,globalFloor?.created_at??-1);
}
function latestHeadEvent(head:Head) {
  return [head.addressDelete,head.eventDelete].reduce((latest,event)=>event && newer(event,latest)?event:latest,head.event);
}
function restoreHeads(){
  try {
    const raw=globalThis.localStorage?.getItem(storageKey);
    if(!raw || raw===lastPayload || raw.length>cacheBytes || bytes(raw)>cacheBytes)return;
    lastPayload=raw;
    const stored=JSON.parse(raw), rows:Head[]=stored.heads;
    if(!Array.isArray(rows) || rows.length>cacheRecords || !Array.isArray(stored.deletions) || stored.deletions.length>128)return;
    const previousFloors=new Map(floors), previousGlobal=globalFloor;
    if(stored.globalFloor)try{
      const event=verified(stored.globalFloor,stored.globalFloor.pubkey,seconds());
      if(newer(event,globalFloor))globalFloor=event;
    }catch{}
    if(Array.isArray(stored.floors))for(const floor of stored.floors.slice(0,128))try{
      advanceFloor(verified(floor,floor.pubkey,seconds()));
    }catch{}
    for(const input of stored.deletions)try{
      const event=verified(input,input.pubkey,seconds());
      if(event.kind===5)queuedDeletes.set(event.id,event);
    }catch{/* Discard unverifiable deletion requests. */}
    for(const row of rows)try{
      const event=verified(row.event,row.event.pubkey,seconds());
      // Preserve retained signed heads on first load. A stale write in another tab
      // cannot revive a coordinate that has since fallen outside this tab’s window.
      const previousCutoff=Math.max(previousFloors.get(event.pubkey)?.created_at??-1,previousGlobal?.created_at??-1);
      admitHead(publicHeads,event,previousCutoff);
      for(const deletion of [row.addressDelete,row.eventDelete])if(deletion)admitDelete(publicHeads,verified(deletion,event.pubkey,seconds()));
    }catch{/* One invalid stored record cannot suppress another signer's records. */}
    trimHeads();
  }catch{/* The public worker remains available if browser storage is disabled. */}
}
function trimHeads(){
  let size=128+COLLECTION_LIMITS.eventBytes+cacheBytes/8;
  const recentDeletes=[...queuedDeletes.values()].sort((a,b)=>b.created_at-a.created_at || a.id.localeCompare(b.id));
  for(const [index,event] of recentDeletes.entries()){
    const eventSize=bytes(JSON.stringify(event))+1;
    if(index>=128 || size+eventSize>cacheBytes/3){queuedDeletes.delete(event.id);advanceFloor(event);}
    else size+=eventSize;
  }
  const recent=[...publicHeads.entries()].reverse();
  for(const [index,[address,head]] of recent.entries()){
    size+=bytes(JSON.stringify(head))+1;
    if(index>=cacheRecords || size>cacheBytes){publicHeads.delete(address);advanceFloor(latestHeadEvent(head));}
  }
  // Per-author watermarks avoid excluding older products from unrelated profiles.
  // Only share an age boundary when even that bounded set of watermarks is full.
  let floorSize=0;
  const byTime=[...floors.values()].sort((a,b)=>b.created_at-a.created_at || a.id.localeCompare(b.id));
  for(const [index,event] of byTime.entries()){
    const eventSize=bytes(JSON.stringify(event))+1;
    if(index>=128 || floorSize+eventSize>cacheBytes/8){
      floors.delete(event.pubkey);
      if(newer(event,globalFloor))globalFloor=event;
    }else floorSize+=eventSize;
  }
}
function saveHeads(){
  restoreHeads(); trimHeads();
  try{
    const payload=JSON.stringify({heads:[...publicHeads.values()],deletions:[...queuedDeletes.values()],floors:[...floors.values()],globalFloor});
    globalThis.localStorage?.setItem(storageKey,payload); lastPayload=payload;
  }catch{
    // Avoid reviving the prior snapshot after a newer winner couldn't be saved.
    try{globalThis.localStorage?.removeItem(storageKey);}catch{}
  }
}
export function rememberAcceptedCollection(input:Event) {
  const event=verified(input,input.pubkey,seconds());
  restoreHeads();
  if(admitHead(publicHeads,event,cutoff(event.pubkey))){
    for(const deletion of queuedDeletes.values())admitDelete(publicHeads,deletion);
    saveHeads();
  }
}
export function rememberCollection(input:Event, delivery:Delivery='published') {
  if(delivery==='published')rememberAcceptedCollection(input);
  return parseCollection(input,input.pubkey,seconds(),delivery);
}
function profileHeads(author:string, pending:Event[]) {
  requireField(hex.test(author),'Invalid collection profile.');
  restoreHeads();
  const heads=new Map([...publicHeads].filter(([,head])=>head.event.pubkey===author).map(([key,head])=>[key,{...head}]));
  const queued=new Set<string>();
  for(const input of pending.slice(0,128))try{
    const event=verified(input,author,seconds());
    if(admitHead(heads,event))queued.add(event.id);
  }catch{/* Only a valid signed update from this profile can win. */}
  for(const deletion of queuedDeletes.values())admitDelete(heads,deletion);
  return {heads,queued};
}
function project(heads:Map<string,Head>, queued:Set<string>) {
  const result:ProductCollection[]=[], now=seconds();
  for(const head of heads.values())try{
    if(deleted(head))continue;
    // All admitted heads are already verified. Copy before exposing mutable tags to the UI.
    const data=fields(head.event);
    if(data.expiration===null || data.expiration>now)result.push({...data,author:head.event.pubkey,event:structuredClone(head.event),delivery:queued.has(head.event.id)?'queued':'published'});
  }catch{/* Keep an invalid or expired signed winner, never redisplay its older revision. */}
  return result.sort((a,b)=>b.event.created_at-a.event.created_at || a.event.id.localeCompare(b.event.id)).slice(0,COLLECTION_LIMITS.perProfile);
}
export function cachedCollections(author:string,pending:Event[]=[]):ProductCollection[] {
  const {heads,queued}=profileHeads(author,pending);
  return project(heads,queued);
}
export function checkCollectionRevision(draft:EventTemplate,author:string,pending:Event[],expectedId:string|null) {
  const identifier=single(draft.tags,'d');
  const {heads,queued}=profileHeads(author,pending);
  const visible=project(heads,queued);
  const current=visible.find(collection=>collection.identifier===identifier);
  const unchanged=expectedId===null?!heads.has(`${COLLECTION_KIND}:${author}:${identifier}`):current?.event.id===expectedId;
  requireField(unchanged,'This collection changed. Reopen it before editing.');
  if(expectedId===null)requireField(visible.length<COLLECTION_LIMITS.perProfile,'A profile can have up to 32 public collections.');
}
export function buildCollectionDraft({author,title,members,previous,now=seconds()}:{
  author:string;title:string;members:string[];previous?:ProductCollection;now?:number;
}):EventTemplate {
  requireField(typeof title==='string' && Array.isArray(members) && members.every(productAddress),'Choose valid marketplace listings.');
  const prior=previous && parseCollection(previous.event,author,now);
  if(prior){
    restoreHeads();
    const current=publicHeads.get(addressOf(prior.event));
    requireField(!current || !newer(current.event,prior.event) && !(current.event.id===prior.event.id && deleted(current)),
      'This collection changed. Reopen it before editing.');
  }
  const original=prior?.event.tags??[];
  const retained=original.filter(tag=>tag[0]!=='d' && tag[0]!=='title' && !isProductTag(tag)).map(tag=>[...tag]);
  const originalMembers=new Map<string,string[]>();
  for(const tag of original.filter(isProductTag))if(!originalMembers.has(tag[1]))originalMembers.set(tag[1],tag);
  const draft={kind:COLLECTION_KIND,created_at:Math.max(now,(prior?.event.created_at??-1)+1),content:prior?.event.content??'',
    tags:[['d',prior?.identifier??crypto.randomUUID()],['title',title.trim()],...members.map(address=>[...(originalMembers.get(address)??['a',address])]),...retained]};
  return validateCollectionDraft(draft,author,now);
}

export async function loadCollections(author:string,{query,signal,pending=[]}:{query:CollectionQuery;signal?:AbortSignal;pending?:Event[]}) {
  requireField(hex.test(author),'Invalid collection profile.');
  if(signal?.aborted)throw new DOMException('Collection lookup cancelled.','AbortError');
  const deadline=Date.now()+6000, initialCutoff=cutoff(author);
  let budget=2*1024*1024, incomplete=false, dirty=false;
  const {heads:initial,queued}=profileHeads(author,pending);
  const pendingHeads=new Map([...initial].filter(([,head])=>queued.has(head.event.id)));
  async function read(filters:Filter[],limit:number,kind:number) {
    const report=await query(filters,{signal,deadline,limit,cache:'cache-first'});
    if(signal?.aborted)throw new DOMException('Collection lookup cancelled.','AbortError');
    incomplete ||= report.complete===false || report.events.length>=limit;
    for(const input of report.events.slice(0,limit)){
      if(input?.pubkey!==author || input.kind!==kind)continue;
      try{
        const event=verified(input,author,seconds());
        budget-=bytes(JSON.stringify(event));
        if(budget<0){incomplete=true;break;}
        if(kind===COLLECTION_KIND && event.created_at<=cutoff(author) && !publicHeads.has(addressOf(event)))incomplete=true;
        const accepted=kind===5?admitDelete(publicHeads,event):admitHead(publicHeads,event,cutoff(event.pubkey));
        dirty ||= accepted;
        if(kind===5 && admitDelete(pendingHeads,event)){
          queuedDeletes.set(event.id,event); dirty=true;
        }
      }catch{/* Ignore malformed signatures and invalid addresses. */}
    }
  }
  try{
    await read([{kinds:[COLLECTION_KIND],authors:[author],limit:COLLECTION_LIMITS.perProfile}],COLLECTION_LIMITS.perProfile,COLLECTION_KIND);
    const {heads}=profileHeads(author,pending);
    const entries=[...heads].sort(([,a],[,b])=>b.event.created_at-a.event.created_at || a.event.id.localeCompare(b.event.id)).slice(0,COLLECTION_LIMITS.perProfile);
    if(entries.length && budget>0)await read([
      {kinds:[5],authors:[author],'#a':entries.map(([address])=>address),limit:128},
      {kinds:[5],authors:[author],'#e':entries.map(([,head])=>head.event.id),limit:128},
    ],256,5);
    if(dirty)saveHeads();
    dirty=false;
    return {collections:cachedCollections(author,pending),incomplete:incomplete || cutoff(author)>initialCutoff};
  }finally{if(dirty)saveHeads();}
}
