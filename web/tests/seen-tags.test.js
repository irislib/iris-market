import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent } from 'nostr-tools/pure'
import { SeenTags, TAG_LIMITS } from '../src/seen-tags.ts'
import { MarketRelayClient } from '../src/market.ts'

const now=1800000000,key=new Uint8Array(32).fill(8),second=new Uint8Array(32).fill(9)
const event=(tags=['laptop'],options={})=>finalizeEvent({kind:30402,created_at:options.at??now-10,content:'A used item',
  tags:[['d',options.id??'item'],['title',options.title??'ThinkPad'],...tags.map(tag=>['t',tag]),...(options.extra??[])]},options.key??key)
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))

test('only signed listings teach observed spellings; duplicates and one-author repetition cannot inflate counts',()=>{
  const tags=new SeenTags(),good=event(['Electronics','laptop','nostr','123'])
  assert.equal(tags.observe({...good,content:'forged'},now),false)
  assert.equal(tags.observe({...good,kind:1},now),false)
  assert.equal(tags.observe(good,now),true);assert.equal(tags.observe(good,now),false)
  tags.observe(event(['Electronics','laptop'],{id:'second'}),now)
  assert.deepEqual(tags.entries().map(item=>[item.tag,item.authors]),[['electronics',1],['laptop',1]])
  assert.deepEqual(tags.select('electronics'),['Electronics','laptop'])
  assert.equal(tags.has('electronics'),false);assert.equal(tags.has('Electronics'),true)
})

test('electronics and clothing expand only to actually observed relevant tags with deterministic ranking',()=>{
  const tags=new SeenTags()
  for(const tag of ['shirts','shoes','laptop','iPhone','headphones','furniture'])tags.observe(event([tag],{id:tag}),now)
  assert.deepEqual(tags.select('clothing under €50'),['shirts','shoes'])
  assert.deepEqual(tags.select('electronics in Helsinki'),['headphones','iPhone','laptop'])
  assert.deepEqual(tags.select('teleporters'),[])
  assert.deepEqual(tags.select('electronics'.repeat(2000)),[])
})

test('co-occurrence needs independent authors and cannot connect every item through generic market tags',()=>{
  const tags=new SeenTags()
  tags.observe(event(['clothing','handmade','marketplace'],{id:'first'}),now)
  tags.observe(event(['clothing','handmade'],{id:'repeat'}),now)
  assert.deepEqual(tags.select('clothing'),['clothing'])
  tags.observe(event(['clothing','handmade'],{key:second}),now)
  assert.deepEqual(tags.select('clothing'),['clothing','handmade'])
  assert.ok(!tags.has('marketplace'))
})

test('tag, event and pair storage stay bounded under signed adversarial input',()=>{
  const tags=new SeenTags()
  for(let i=0;i<140;i++)tags.observe(event(Array.from({length:20},(_,n)=>`category${i*20+n}`),{id:String(i)}),now)
  const stats=tags.stats();assert.equal(stats.tags,TAG_LIMITS.tags);assert.ok(stats.pairs<=TAG_LIMITS.pairs);assert.ok(stats.events<=TAG_LIMITS.events)
  assert.ok(tags.select('category0').length<=TAG_LIMITS.queryTags)
})

class Socket {
  static instances=[]
  readyState=0;sent=[];closed=false
  constructor(url){this.url=url;Socket.instances.push(this)}
  send(raw){this.sent.push(JSON.parse(raw))}
  open(){this.readyState=1;this.onopen?.()}
  record(value){this.onmessage?.({data:JSON.stringify(['EVENT',this.sent[0][1],value])})}
  eose(){this.onmessage?.({data:JSON.stringify(['EOSE',this.sent[0][1]])})}
  close(){this.closed=true;this.readyState=3}
}
function client(options={}){
  Socket.instances=[];const tags=new SeenTags();tags.observe(event(['laptop']),now)
  return new MarketRelayClient({relays:['wss://relay.example'],WebSocketImpl:Socket,indexQuery:null,now:()=>now,tagCatalogue:tags,...options}).start()
}

test('semantic candidates use separate tag pagination without a literal title prefilter',async()=>{
  const feed=client();assert.deepEqual(feed.searchTags('electronics'),['laptop'])
  const pending=feed.loadQueryCandidates();assert.equal(pending,feed.loadQueryCandidates());await tick()
  const reader=Socket.instances[1];reader.open()
  assert.deepEqual(reader.sent[0][2]['#t'],['laptop']);assert.equal(reader.sent[0][2].limit,80)
  reader.record(event(['laptop'],{title:'ThinkPad T480',id:'computer'}));reader.eose()
  const result=await pending;assert.equal(result.added,1);assert.equal(result.hasMore,true);assert.equal(feed.listings()[0].title,'ThinkPad T480')
  assert.equal(feed.history.values().next().value.started,false)
  const older=feed.loadQueryCandidates();await tick();const next=Socket.instances[2];next.open()
  assert.equal(next.sent[0][2].until,now-10);next.eose();assert.equal((await older).hasMore,false);feed.close()
})

test('changing the search cancels its reader and late results cannot enter the listing store',async()=>{
  const feed=client();feed.searchTags('electronics');const pending=feed.loadQueryCandidates();await tick()
  const reader=Socket.instances[1];reader.open();const handler=reader.onmessage,subscription=reader.sent[0][1]
  feed.searchTags('');assert.ok(reader.closed)
  handler({data:JSON.stringify(['EVENT',subscription,event(['laptop'])])})
  await pending;assert.equal(feed.records.size,0);assert.equal(feed.queryPagination().hasMore,false);feed.close()
})

test('index candidates have a separate bounded cursor and retain expired winners against relay replays',async()=>{
  const expired=event(['laptop'],{at:now-5,extra:[['expiration',String(now-1)]]}),calls=[]
  const feed=client({relays:[],indexQuery:async(filters)=>{calls.push(filters);return{events:[expired],complete:true}}})
  await tick();feed.searchTags('electronics');await feed.loadQueryCandidates()
  assert.ok(calls.some(filters=>filters[0]['#t']?.includes('laptop')))
  feed.acceptListing(feed.parseIncoming(event(['laptop'],{at:now-10})))
  assert.equal(feed.records.values().next().value.eventId,expired.id);assert.deepEqual(feed.listings(),[]);feed.close()
})

test('an early search learns candidate tags when verified live listings arrive',async()=>{
  const feed=client({tagCatalogue:new SeenTags()});assert.deepEqual(feed.searchTags('clothing'),[])
  const base=Socket.instances[0];base.open();base.record(event(['shirts']))
  await new Promise(resolve=>setTimeout(resolve,35));assert.deepEqual(feed.queryTags,['shirts']);assert.equal(Socket.instances.length,2);feed.close()
})

test('clearing a query releases an index batch even if its provider ignores cancellation',async()=>{
  const feed=client({relays:[],indexQuery:()=>new Promise(()=>{})});feed.searchTags('electronics')
  const pending=feed.loadQueryCandidates();await tick();feed.searchTags('')
  await pending;assert.equal(feed.queryPagination().hasMore,false);feed.close()
})
