import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, toHex } from '@hashtree/core'
import { NostrEventStore } from '@hashtree/nostr'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { createPublicIndex } from '../src/public-index.ts'
import { MarketRelayClient } from '../src/market.ts'
import { queryProfileRecords } from '../src/profiles.ts'
import { fetchFollows } from '../src/social.ts'
import { createNostrRuntime } from 'nostr-pubsub'
import { serveNostrSource, connectNostrSource } from '@hashtree/worker/nostr-source-port'
import {createShippingResolver} from '../src/shipping.ts'
import {parseEvent} from '../src/market.ts'

const key=generateSecretKey(),author=getPublicKey(key),now=Math.floor(Date.now()/1000)
const sign=(kind,tags=[],created_at=now-10,content='')=>finalizeEvent({kind,tags,created_at,content},key)
const listing=(at,tags=[])=>sign(30402,[['d','item'],['title','Bicycle'],...tags],at)
const ref=`${npubEncode(author)}/nostr-event-index`
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
async function fixture(events){
  const store=new MemoryStore(),root=await new NostrEventStore(store).build(null,events)
  const pointer=sign(30078,[['d','nostr-event-index'],['l','hashtree'],['hash',toHex(root.hash)],...(root.key?[['key',toHex(root.key)]]:[])])
  return {store,pointer}
}

test('Hashtree source keeps expired winning records and uses cached signed roots without relay replies',async()=>{
  const old=listing(now-20),expired=listing(now-10,[['expiration',String(now-1)]]),profile=sign(0,[],now-5,'{"name":"Sam"}')
  const {store,pointer}=await fixture([old,expired,profile]);let calls=0
  const index=createPublicIndex({store,refs:[ref],now:()=>now,queryRoots:async(_filters,options)=>{calls++;return options.cache==='cache-only'?{events:[pointer]}:new Promise(()=>{})}})
  const result=await index.query([{kinds:[30402],limit:10}],{deadline:Date.now()+1000})
  assert.deepEqual(result.events.map(item=>item.event.id),[expired.id]);assert.equal(result.complete,true);assert.equal(calls,2)
  const profiles=await index.source.query([{kinds:[0],authors:[author]}]);assert.equal(profiles.events[0].event.id,profile.id)
})

test('unverified, wrong-owner and private root pointers do not expose data',async()=>{
  const item=listing(now-10),{store,pointer}=await fixture([item])
  const privatePointer=sign(30078,[...pointer.tags,['selfEncryptedKey','not-public']])
  for(const invalid of [{...pointer,content:'tampered'},privatePointer]){
    const index=createPublicIndex({store,refs:[ref],now:()=>now,queryRoots:async()=>({events:[invalid]})})
    const result=await index.query([{kinds:[30402]}]);assert.deepEqual(result.events,[]);assert.equal(result.complete,false)
  }
})

test('public source never traverses index data for private scopes or root discovery',async()=>{
  let calls=0;const index=createPublicIndex({refs:[ref],queryRoots:async()=>{calls++;return{events:[]}}})
  for(const kinds of [[1059],[1060],[30078]])assert.deepEqual(await index.source.query([{kinds}]),{events:[],complete:true})
  assert.equal(calls,0)
})

test('referenced public collections and shipping options can be read when an archive contains them',async()=>{
  const collection=sign(30405,[['d','collection'],['title','Collection']]),shipping=sign(30406,[['d','post'],['title','Post']]);
  const {store,pointer}=await fixture([collection,shipping]);
  const index=createPublicIndex({store,refs:[ref],now:()=>now,queryRoots:async()=>({events:[pointer]})});
  const result=await index.query([{kinds:[30405,30406],authors:[author]}]);
  assert.deepEqual(result.events.map(item=>item.event.id).sort(),[collection.id,shipping.id].sort());
})

test('cancellation does not wait for a silent root-discovery connection',async()=>{
  const controller=new AbortController(),index=createPublicIndex({refs:[ref],queryRoots:()=>new Promise(()=>{})})
  const pending=index.query([{kinds:[0]}],{signal:controller.signal});controller.abort()
  await assert.rejects(pending,{name:'AbortError'})
})

test('durable listing and later relay replay converge through the same expiry reducer',async()=>{
  const old=listing(now-20),expired=listing(now-10,[['expiration',String(now-1)]])
  class Socket {readyState=0;send(){}close(){}}
  const client=new MarketRelayClient({relays:['wss://example.test'],WebSocketImpl:Socket,now:()=>now,indexQuery:async()=>({events:[expired]})}).start()
  await tick();client.acceptListing((await import('../src/market.ts')).parseEvent(old,{now}))
  assert.equal(client.records.size,1);assert.equal(client.records.values().next().value.eventId,expired.id);assert.deepEqual(client.listings(),[]);client.close()
})

test('closing listing view cancels index read and ignores a late response',async()=>{
  let finish,signal;class Socket {readyState=0;send(){}close(){}}
  const client=new MarketRelayClient({relays:['wss://example.test'],WebSocketImpl:Socket,now:()=>now,indexQuery:(_filters,options)=>{signal=options.signal;return new Promise(resolve=>finish=resolve)}}).start()
  client.close();assert.ok(signal.aborted);finish({events:[listing(now-10)]});await tick();assert.equal(client.records.size,0)
})

test('profile and follow adapters use verified worker results even without complete relay coverage',async()=>{
  const profile=sign(0,[],now-5,'{"name":"Sam"}'),follows=sign(3,[['p','a'.repeat(64)]],now-4)
  const runtime={query:async filters=>({events:filters[0].kinds.includes(0)?[profile,{...profile,content:'forged'}]:[follows],complete:false,sources:[],reason:'timeout'})}
  const profiles=await queryProfileRecords([{kinds:[0],authors:[author]}],{runtime,now:()=>now});assert.equal(profiles.events[0].id,profile.id)
  assert.deepEqual((await fetchFollows(author,{runtime,now:()=>now})).authors,['a'.repeat(64)])
})

test('the real shared-worker source bridge reaches Hashtree history after subscribing',async()=>{
  const profile=sign(0,[],now-5,'{"name":"Sam"}'),{store,pointer}=await fixture([profile])
  const index=createPublicIndex({store,refs:[ref],now:()=>now,queryRoots:async()=>({events:[pointer]})})
  const channel=new MessageChannel(),serveClose=serveNostrSource(channel.port1,index.source)
  const bridge=connectNostrSource(channel.port2,index.source.id)
  const runtime=createNostrRuntime({relays:[],sources:[bridge.source]})
  try{
    const result=await runtime.query([{kinds:[0],authors:[author]}],{deadline:Date.now()+1500})
    assert.deepEqual(result.events.map(event=>event.id),[profile.id]);assert.equal(result.complete,true)
  }finally{await runtime.close();bridge.close();serveClose()}
})

test('shipping resolver follows a signed collection through the real shared-worker source bridge',async()=>{
  const shipping=sign(30406,[['d','post'],['title','Post'],['price','5','EUR'],['country','FI'],['service','standard']]);
  const collection=sign(30405,[['d','collection'],['title','Collection'],['shipping_option',`30406:${author}:post`]]);
  const item=parseEvent(listing(now-10,[['shipping_option',`30405:${author}:collection`]]),{now});
  const {store,pointer}=await fixture([shipping,collection]);
  const index=createPublicIndex({store,refs:[ref],now:()=>now,queryRoots:async()=>({events:[pointer]})});
  const channel=new MessageChannel(),serveClose=serveNostrSource(channel.port1,index.source),bridge=connectNostrSource(channel.port2,index.source.id);
  const runtime=createNostrRuntime({relays:[],sources:[bridge.source]});
  try{
    const resolver=createShippingResolver({query:(filters,options)=>runtime.query(filters,options),now:()=>now});
    const result=await resolver.load([item]);assert.deepEqual(result.byListing.get(item.id).destinations,['FI']);
    assert.equal(result.byListing.get(item.id).options[0].eventId,shipping.id);
  }finally{await runtime.close();bridge.close();serveClose()}
})
