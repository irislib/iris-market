import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent } from 'nostr-tools/pure'
import { SeenTags, TAG_LIMITS, literalSearchTags } from '../src/seen-tags.ts'
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
  assert.deepEqual(tags.select('electronics'),['electronics','Electronics'])
  assert.equal(tags.has('electronics'),false);assert.equal(tags.has('Electronics'),true)
})

test('direct query tags precede actually observed related tags with deterministic ranking',()=>{
  const tags=new SeenTags()
  for(const tag of ['shirts','shoes','laptop','iPhone','headphones','furniture'])tags.observe(event([tag],{id:tag}),now)
  assert.deepEqual(tags.select('clothing under €50'),['clothing under 50','clothing'])
  assert.deepEqual(tags.select('electronics in Helsinki'),['electronics in helsinki','electronics','helsinki'])
  assert.deepEqual(tags.select('teleporters'),['teleporters'])
  assert.deepEqual(tags.select('electronics'.repeat(2000)),[])
})

test('cold search uses bounded literal tags without waiting to observe a matching listing',()=>{
  const tags=new SeenTags();assert.deepEqual(tags.select(' #TELEPORTERS '),['teleporters'])
  assert.deepEqual(literalSearchTags('a travel partner in Helsinki'),['a travel partner in helsinki','travel','partner','helsinki'])
  assert.equal(literalSearchTags('x'.repeat(61)).length,0)
  assert.ok(literalSearchTags('one two three four five six seven').length<=TAG_LIMITS.literalTags)
})

test('unrelated and misspelled observed tags are never guessed',()=>{
 const tags=new SeenTags();for(const tag of ['camera','clothing','laptop'])tags.observe(event([tag],{id:tag}),now)
 assert.deepEqual(tags.select('camra'),['camra']);assert.deepEqual(tags.select('electronics'),['electronics'])
})

test('optional model tag plans admit observed spellings only and cannot displace the direct query',()=>{
  const tags=new SeenTags();for(const tag of ['iPhone','laptop','handmade','wood','ceramic','books','travel','music','garden'])tags.observe(event([tag],{id:tag}),now)
  const selected=tags.select('unseen',8,['hallucinated','iphone','laptop','handmade','wood','ceramic','books','travel','music'])
  assert.equal(selected[0],'unseen');assert(!selected.includes('hallucinated'));assert(selected.includes('iPhone'));assert(selected.length<=8);assert(selected.slice(1).every(tag=>tags.has(tag)))
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
  Socket.instances=[];const tags=new SeenTags();tags.observe(event(['electronics','laptop'],{id:'a'}),now);tags.observe(event(['electronics','laptop'],{id:'b',key:second}),now)
  const feed=new MarketRelayClient({relays:['wss://relay.example'],WebSocketImpl:Socket,indexQuery:null,now:()=>now,tagCatalogue:tags,...options}).start()
  const read=feed.readHistory.bind(feed);feed.readHistory=(url,until,limit,options={})=>options.search?Promise.resolve({count:0,oldest:null}):read(url,until,limit,options)
  return feed
}

test('semantic candidates use separate tag pagination without a literal title prefilter',async()=>{
  const feed=client();assert.deepEqual(feed.searchTags('electronics',undefined,'expanded'),['electronics','laptop'])
  const pending=feed.loadQueryCandidates();assert.equal(pending,feed.loadQueryCandidates());await tick()
  const exact=Socket.instances[1];exact.open();assert.deepEqual(exact.sent[0][2]['#t'],['electronics']);exact.eose()
  const reader=Socket.instances[2];reader.open()
  assert.deepEqual(reader.sent[0][2]['#t'],['laptop']);assert.equal(reader.sent[0][2].limit,80)
  reader.record(event(['laptop'],{title:'ThinkPad T480',id:'computer'}));reader.eose()
  const result=await pending;assert.equal(result.added,1);assert.equal(result.hasMore,true);assert.equal(feed.listings()[0].title,'ThinkPad T480')
  assert.equal(feed.history.values().next().value.started,false)
  const older=feed.loadQueryCandidates();await tick();const next=Socket.instances[3];next.open()
  assert.equal(next.sent[0][2].until,now-10);next.eose();assert.equal((await older).hasMore,false);feed.close()
})

test('changing the search cancels its reader and late results cannot enter the listing store',async()=>{
  const feed=client();feed.searchTags('electronics',undefined,'expanded');const pending=feed.loadQueryCandidates();await tick()
  const reader=Socket.instances[2];reader.open();const handler=reader.onmessage,subscription=reader.sent[0][1]
  feed.searchTags('');assert.ok(reader.closed)
  handler({data:JSON.stringify(['EVENT',subscription,event(['laptop'])])})
  await pending;assert.equal(feed.records.size,0);assert.equal(feed.queryPagination().hasMore,false);feed.close()
})

test('index candidates have a separate bounded cursor and retain expired winners against relay replays',async()=>{
  const expired=event(['laptop'],{at:now-5,extra:[['expiration',String(now-1)]]}),calls=[]
  const feed=client({relays:[],indexQuery:async(filters)=>{calls.push(filters);return{events:[expired],complete:true}}})
  await tick();feed.searchTags('electronics',undefined,'expanded');await feed.loadQueryCandidates()
  assert.ok(calls.some(filters=>filters[0]['#t']?.includes('laptop')))
  feed.acceptListing(feed.parseIncoming(event(['laptop'],{at:now-10})))
  assert.equal(feed.records.values().next().value.eventId,expired.id);assert.deepEqual(feed.listings(),[]);feed.close()
})

test('an early search learns candidate tags when verified live listings arrive',async()=>{
  const feed=client({tagCatalogue:new SeenTags()});assert.deepEqual(feed.searchTags('clothing',undefined,'expanded'),['clothing'])
  await tick();const direct=Socket.instances[1];direct.open();assert.deepEqual(direct.sent[0][2]['#t'],['clothing']);direct.eose()
  const base=Socket.instances[0];base.open();base.record(event(['clothing','shirts'],{id:'learn1'}));base.record(event(['clothing','shirts'],{id:'learn2',key:second}))
  await new Promise(resolve=>setTimeout(resolve,35));assert.deepEqual(feed.queryTags,['clothing','shirts']);assert.equal(Socket.instances.length,3)
  assert.equal(feed.queryPlans[0].history.values().next().value.exhausted,true,'adding observed tags preserves the direct cursor');feed.close()
})

test('direct and expanded discovery starts before generic history and shares a finite request budget',async()=>{
  const feed=client();feed.searchTags('electronics',['laptop','unobserved'],'expanded');const pending=feed.loadQueryCandidates();await tick()
  assert.equal(Socket.instances.length,3);assert.equal(feed.history.values().next().value.started,false);assert.equal(feed.queryRequestBudget.count,3)
  for(const reader of Socket.instances.slice(1)){reader.open();reader.eose()}
  await pending;feed.queryRequestBudget.count=31
  feed.searchTags('electronics',['laptop'],'expanded');await tick();assert.equal(feed.queryRequestBudget.count,31,'same plan does not refill the budget')
  feed.setQueryTags(['laptop']);await tick();assert.equal(feed.queryRequestBudget.count,1,'a new explicit plan has a fresh bounded scope');feed.close()
})

test('repeated model-plan refinements cannot bypass the total per-search read cap',async()=>{
  const catalogue=new SeenTags();for(let index=0;index<40;index++)catalogue.observe(event([`topic${index}`],{id:String(index)}),now)
  const feed=client({tagCatalogue:catalogue})
  try{
    let seen=1
    for(let index=0;index<40;index++){
      feed.searchTags('unseen',[`topic${index}`],'expanded');const pending=feed.loadQueryCandidates();await tick()
      for(const reader of Socket.instances.slice(seen)){reader.open();reader.eose()}
      seen=Socket.instances.length;await pending
    }
    assert.equal(feed.queryRequestBudget.count,32);assert.equal(Socket.instances.length,32,'31 tag reads plus one keyword read share the finite cap')
    assert.equal(feed.queryPagination().limited,true);assert.equal(feed.queryPagination().hasMore,false);assert.equal(feed.history.values().next().value.started,false)
  }finally{feed.close()}
})

test('clearing a query releases an index batch even if its provider ignores cancellation',async()=>{
  const feed=client({relays:[],indexQuery:()=>new Promise(()=>{})});feed.searchTags('electronics',undefined,'expanded')
  const pending=feed.loadQueryCandidates();await tick();feed.searchTags('')
  await pending;assert.equal(feed.queryPagination().hasMore,false);feed.close()
})


test('normal retrieval keeps literal query tags and ignores families, typos, co-occurrence and model tags',async()=>{
  const tags=new SeenTags()
  for(const [id,author] of [['first',key],['second',second]])tags.observe(event(['electronics','laptop','handmade'],{id,key:author}),now)
  tags.observe(event(['camera'],{id:'camera'}),now)
  assert.ok(tags.select('electronics').includes('laptop'))
  assert.deepEqual(tags.select('camra'),['camra'])
  const feed=client({tagCatalogue:tags})
  try{
    assert.deepEqual(feed.searchTags('electronics',['laptop','handmade']),['electronics'])
    assert.equal(feed.queryExpansion,'literal');assert.deepEqual(feed.queryExtraTags,[])
    await tick();const direct=Socket.instances[1];direct.open();assert.deepEqual(direct.sent[0][2]['#t'],['electronics']);direct.eose();await feed.loadQueryCandidates()
    assert.equal(Socket.instances.length,2,'no related-tag reader is opened')
    assert.deepEqual(feed.searchTags('camra',['camera']),['camra'])
    await tick();const typo=Socket.instances.at(-1);typo.open();assert.deepEqual(typo.sent[0][2]['#t'],['camra']);typo.eose();await feed.loadQueryCandidates()
    assert.deepEqual(feed.searchTags('a travel partner in Helsinki'),['a travel partner in helsinki','travel','partner','helsinki'])
  }finally{feed.close()}
})

test('normal searches cannot expand when newly observed inventory arrives',async()=>{
  const feed=client({tagCatalogue:new SeenTags()})
  try{
    feed.searchTags('clothing');await tick();const direct=Socket.instances[1];direct.open();direct.eose();await feed.loadQueryCandidates()
    const live=Socket.instances[0];live.open();live.record(event(['shirts']))
    await new Promise(resolve=>setTimeout(resolve,35))
    assert.deepEqual(feed.queryTags,['clothing']);assert.equal(feed.tagSelectionTimer,null);assert.equal(Socket.instances.length,2)
    assert.equal(feed.queryPlans[0].history.values().next().value.exhausted,true)
  }finally{feed.close()}
})

test('switching policy cancels and resets identical tag cursors without dropping stored results',async()=>{
  const catalogue=new SeenTags();catalogue.observe(event(['teleporters']),now)
  const feed=client({tagCatalogue:catalogue})
  try{
    feed.searchTags('teleporters');const oldPending=feed.loadQueryCandidates();await tick()
    const oldReader=Socket.instances[1];oldReader.open();oldReader.record(event(['teleporters'],{id:'kept'}));const oldHandler=oldReader.onmessage,subscription=oldReader.sent[0][1],oldController=feed.queryController,oldPlan=feed.queryPlans[0]
    oldPlan.history.values().next().value.cursor=now-100;feed.queryRequestBudget.count=31
    feed.searchTags('teleporters',undefined,'expanded')
    assert.equal(oldController.signal.aborted,true);assert.equal(oldReader.closed,true);assert.notEqual(feed.queryPlans[0],oldPlan);assert.equal(feed.queryPlans[0].history.values().next().value.cursor,null)
    await tick();assert.equal(feed.queryRequestBudget.count,2)
    oldHandler({data:JSON.stringify(['EVENT',subscription,event(['teleporters'],{id:'late'})])})
    const current=Socket.instances[2];current.open();current.eose();await Promise.all([oldPending,feed.loadQueryCandidates()])
    assert.deepEqual(feed.listings().map(row=>row.identifier),['kept']);assert.equal(feed.queryPagination().error,'')
    const expandedPlan=feed.queryPlans[0];feed.searchTags('teleporters',undefined,'literal');await tick()
    assert.notEqual(feed.queryPlans[0],expandedPlan);assert.equal(feed.queryRequestBudget.count,2);assert.deepEqual(feed.queryTags,['teleporters'])
  }finally{feed.close()}
})

test('AI observation refresh preserves its expansion policy and model plan until mode changes',async()=>{
  const tags=new SeenTags();tags.observe(event(['electronics','laptop'],{id:'a'}),now);tags.observe(event(['electronics','laptop'],{id:'b',key:second}),now)
  const feed=client({tagCatalogue:tags})
  try{
    feed.searchTags('electronics',['laptop'],'expanded');await tick()
    const live=Socket.instances[0];live.open();live.record(event(['headphones'],{id:'headphones'}))
    await new Promise(resolve=>setTimeout(resolve,35))
    assert.equal(feed.queryExpansion,'expanded');assert.ok(!feed.queryTags.includes('headphones'));assert.ok(feed.queryExtraTags.includes('laptop'))
    feed.searchTags('electronics',undefined,'literal');assert.deepEqual(feed.queryTags,['electronics']);assert.deepEqual(feed.queryExtraTags,[])
  }finally{feed.close()}
})


test('literal relay spellings match only the normalized query and stay frozen until a new submission scope',async()=>{
  const tags=new SeenTags();tags.observe(event(['Electronics','laptop'],{id:'known-case'}),now)
  const feed=client({tagCatalogue:tags})
  try{
    assert.deepEqual(feed.searchTags('electronics'),['electronics','Electronics'])
    await tick();const direct=Socket.instances[1];direct.open();direct.eose();await tick()
    const variant=Socket.instances[2];variant.open();assert.deepEqual(variant.sent[0][2]['#t'],['Electronics'])
    variant.record(event(['Electronics'],{id:'uppercase-relay-match'}));variant.eose();await feed.loadQueryCandidates()
    assert.ok(feed.listings().some(row=>row.identifier==='uppercase-relay-match'))
    const controller=feed.queryController,plan=feed.queryPlans[0],count=Socket.instances.length
    tags.observe(event(['ELECTRONICS','clothing'],{id:'new-case'}),now)
    assert.deepEqual(feed.searchTags('electronics'),['electronics','Electronics'])
    assert.equal(feed.queryController,controller);assert.equal(feed.queryPlans[0],plan);assert.equal(Socket.instances.length,count)
    feed.searchTags('other');assert.deepEqual(feed.searchTags('electronics'),['electronics','ELECTRONICS','Electronics'])
    assert.deepEqual(tags.selectLiteral('t shirt'),['t shirt','shirt'])
    tags.observe(event(['T-Shirt','shirts'],{id:'format'}),now)
    tags.observe(event(['t_shirt'],{id:'other-format'}),now)
    assert.deepEqual(tags.selectLiteral('t shirt'),['t shirt','shirt','T-Shirt','t_shirt'])
  }finally{feed.close()}
})
