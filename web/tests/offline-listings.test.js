import test from 'node:test'
import assert from 'node:assert/strict'
import {finalizeEvent,generateSecretKey} from 'nostr-tools/pure'
import {createPublicListingCache} from '../src/offline-listings.ts'
import {parseEvent,visibleListings,MarketRelayClient} from '../src/market.ts'

const now=1800000000,key=generateSecretKey()
const signed=({id='chair',at=now-20,status='active',extra=[],content='A useful chair',kind=30402}={})=>finalizeEvent({kind,created_at:at,tags:[['d',id],['title','Chair'],['status',status],...extra],content},key)
const validate=event=>parseEvent(event,{now}),copy=value=>JSON.parse(JSON.stringify(value))
function memoryBackend(events=[]){
  const rows=new Map(events.map(event=>[validate(event).id,copy(event)]));let failed=false
  return{rows,fail(){failed=true},async read(limit){return [...rows.values()].slice(0,limit).map(copy)},async write(events,limit,check){
    if(failed)throw new Error('quota')
    for(const event of events){const next=check(event),previous=rows.get(next.id),old=previous&&check(previous);if((old||rows.size<limit)&&(!old||next.createdAt>old.createdAt||next.createdAt===old.createdAt&&next.eventId<old.eventId))rows.set(next.id,copy(event))}
  }}
}
const cache=backend=>createPublicListingCache({backend,validate})

test('offline inventory re-verifies signed wire data and contains no private events',async()=>{
  const backend=memoryBackend(),store=cache(backend),event=signed()
  store.save(event);store.save(signed({kind:14}));await store.flush()
  event.content='mutated after submission'
  const restored=await cache(backend).load();assert.equal(restored.length,1);assert.equal(restored[0].content,'A useful chair');validate(restored[0])
  const forged=signed({id:'forged'});forged.content='forged cached verification symbol';store.save(forged);await store.flush();assert.equal(backend.rows.size,1)
  backend.rows.values().next().value.content='tampered stored content'
  assert.deepEqual(await cache(backend).load(),[])
})

test('sold and expired winners survive reload, old replay and bounded capacity',async()=>{
  const backend=memoryBackend(),store=createPublicListingCache({backend,validate,maxRecords:2})
  store.save(signed());await store.flush()
  store.save(signed({status:'sold',at:now-10}));store.save(signed({id:'lamp',at:now-5,extra:[['expiration',String(now-1)]]}));await store.flush()
  store.save(signed());store.save(signed({id:'lamp',at:now-15}));store.save(signed({id:'overflow'}));await store.flush()
  const restored=await cache(backend).load(),listings=new Map(restored.map(event=>{const item=validate(event);return[item.id,item]}))
  assert.equal(restored.length,2);assert.equal(visibleListings(listings,{now}).length,0)
  store.save(signed({at:now-1}));await store.flush();assert.equal((await cache(backend).load()).find(event=>event.tags[0][1]==='chair').created_at,now-1)
})

test('equal timestamp winner is deterministic after offline roundtrip',async()=>{
  const backend=memoryBackend(),store=cache(backend),a=signed({content:'a'}),b=signed({content:'b'})
  for(const event of [a,b,a])store.save(event)
  await store.flush();assert.equal((await cache(backend).load())[0].id,[a.id,b.id].sort()[0])
})

test('storage failure fails closed so a previously active listing cannot return offline',async()=>{
  const backend=memoryBackend([signed()]),flags=new Map(),storage={getItem:key=>flags.get(key),setItem:(key,value)=>flags.set(key,value)}
  const store=createPublicListingCache({backend,validate,storage});assert.equal((await store.load()).length,1)
  backend.fail();store.save(signed({status:'sold',at:now-1}));await store.flush()
  assert.deepEqual(await store.load(),[]);assert.deepEqual(await createPublicListingCache({backend,validate,storage}).load(),[])
  assert.equal([...flags.values()][0],'1')
})

test('stored expiry is evaluated at the current time without receiving another relay event',async()=>{
  const backend=memoryBackend([signed({extra:[['expiration',String(now+10)]]})]),store=cache(backend)
  const records=new Map((await store.load()).map(event=>{const listing=validate(event);return[listing.id,listing]}))
  assert.equal(visibleListings(records,{now}).length,1);assert.equal(visibleListings(records,{now:now+10}).length,0)
})

test('slow offline hydration never blocks start and cannot replace newer live revisions',async()=>{
  let release;const events=new Promise(resolve=>{release=resolve}),saved=[]
  const client=new MarketRelayClient({relays:[],indexQuery:null,now:()=>now,offlineCache:{load:()=>events,save:event=>saved.push(event.id),flush:async()=>{}}})
  client.start();assert.equal(client.running,true)
  const newer=signed({status:'sold',at:now-1});client.acceptListing(client.parseIncoming(newer));release([signed()])
  await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(client.listings().length,0);assert.equal(client.records.values().next().value.eventId,newer.id);assert.deepEqual(saved,[newer.id]);client.close()
})

test('offline hydration stops on navigation and preserves changed-tag tombstones of known records',async()=>{
  let release;const events=new Promise(resolve=>{release=resolve})
  const client=new MarketRelayClient({relays:[],indexQuery:null,now:()=>now,offlineCache:{load:()=>events,save(){},flush:async()=>{}}}).start()
  client.close();release([signed()]);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(client.records.size,0)
  const active=signed({extra:[['t','chairs']]}),sold=signed({status:'sold',at:now-1,extra:[['t','different']]})
  const filtered=new MarketRelayClient({relays:[],tags:['chairs'],indexQuery:null,now:()=>now,offlineCache:{load:async()=>[sold],save(){},flush:async()=>{}}})
  filtered.acceptListing(validate(active));filtered.start();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(filtered.listings().length,0);filtered.close()
})


test('recovery loader distinguishes legitimate empty inventory from unavailable authority',async()=>{
  const empty=cache(memoryBackend());assert.deepEqual(await empty.loadForRecovery(),[])
  const broken=createPublicListingCache({backend:{async read(){throw Error('unavailable')},async write(){}},validate})
  assert.deepEqual(await broken.load(),[])
  await assert.rejects(broken.loadForRecovery(),/authority is unavailable/)
})

test('recovery loader waits for writes and rejects a failed tombstone update',async()=>{
  const backend=memoryBackend([signed()]),store=cache(backend)
  await store.load();backend.fail();store.save(signed({status:'sold',at:now-1}))
  await assert.rejects(store.loadForRecovery(),/authority is unavailable/)
  assert.deepEqual(await store.load(),[])
})

test('recovery loader keeps signed inactive authority for caller-specific admission',async()=>{
  const sold=signed({status:'sold'}),expired=signed({id:'expired',extra:[['expiration',String(now-1)]]})
  const store=cache(memoryBackend([sold,expired]))
  assert.deepEqual(new Set((await store.loadForRecovery()).map(event=>event.id)),new Set([sold.id,expired.id]))
})
