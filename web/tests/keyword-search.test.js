import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {finalizeEvent} from 'nostr-tools/pure'
import {MarketRelayClient} from '../src/market.ts'
import {readTopicVectors} from '../src/semantic-discovery.ts'
import {SeenTags} from '../src/seen-tags.ts'
import {createSearchDiscovery} from '../src/search-discovery.ts'
import {matchesLiteralSearch,matchesSingleTermSearch,keywordSearches,listingSearchText} from '../src/lexical-search.ts'
const now=1800000000,key=new Uint8Array(32).fill(8)
const signed=(id,title,tags=[],content='')=>finalizeEvent({kind:30402,created_at:now-10,content,tags:[['d',id],['title',title],...tags.map(t=>['t',t])]},key)
const fixtures=[signed('meat','Beef steaks',['meat']),signed('bread','Sourdough bread',['bread']),signed('food','Groceries',['food']),signed('pet','Dog dinner',['petfood']),signed('pan','Cooking pan',['cookware']),signed('literal','Products for human use',[],'Edible fresh produce'),signed('finnish','TUORE LEIPÄ',[],'Helsinki')]
const tick=()=>new Promise(r=>setTimeout(r,0))
const catalogue=()=>{const tags=new SeenTags();for(const event of fixtures)tags.observe(event,now);return tags}
test('single-term guarantees use whole words without dropping constraints or stop words',()=>{
 for(const [text,query] of [['City BICYCLE','bicycle'],['Fresh LEIPÄ','leipä'],['USB-C charger','usb-c'],['The book','the'],['ＦＲＥＳＨ apples','fresh']])assert.equal(matchesSingleTermSearch(text,query),true);
 for(const [text,query] of [['Carpet','car'],['Motorbike','bike'],['Bicycle','a bicycle'],['Bicycle under 200','bicycle under 200'],['Anything','---'],['Anything',''],['C USB charger','usb-c']])assert.equal(matchesSingleTermSearch(text,query),false);
});
test('native and web share the same single-term matching cases',()=>{
 const fixtures=JSON.parse(readFileSync(new URL('./fixtures/single-term-search.json',import.meta.url),'utf8'));
 for(const fixture of fixtures)assert.equal(matchesSingleTermSearch(fixture.text,fixture.query),fixture.match,JSON.stringify(fixture));
});
function indexed(){
 const calls=[]
 const feed=new MarketRelayClient({relays:[],now:()=>now,tagCatalogue:catalogue(),indexSearch:true,indexQuery:async filters=>{const f=filters[0];calls.push(f);return{events:f.search?fixtures:f['#t']?fixtures.filter(e=>e.tags.some(t=>t[0]==='t'&&f['#t'].includes(t[1]))):[],complete:true}}}).start()
 return{feed,calls}
}
test('literal multiword matching supports reordered Unicode words without inventing topic semantics',()=>{
 assert.equal(matchesLiteralSearch('Edible fresh products for human use','human edible products'),true)
 assert.equal(matchesLiteralSearch('Beef steaks','human edible products'),false)
 assert.equal(matchesLiteralSearch('Helsinki: TUORE leipä','leipä tuore'),true)
 assert.equal(matchesLiteralSearch('FRESH BREAD','ＦＲＥＳＨ bread'),true)
 assert.equal(matchesLiteralSearch('breadboard','bread board'),false)
 assert.equal(matchesLiteralSearch('steak','tea'),false)
 assert.equal(matchesLiteralSearch('carpet','car'),false)
 assert.equal(matchesLiteralSearch('Green tea','tea'),true)
 assert.equal(matchesLiteralSearch('Bicycle bright red','red bicycle'),true)
 assert.equal(matchesLiteralSearch('T-Shirt','t shirt'),true)
 assert.deepEqual(keywordSearches('human edible products'),['human edible products','human','edible','products'])
})
test('signed keyword candidates are independent of tags, alternatives and unsupported index precision',async()=>{
 const {feed,calls}=indexed()
 try{
  feed.searchTags('human edible products');await feed.loadQueryCandidates()
  const requests=calls.filter(f=>f.search)
  assert.deepEqual(requests.map(f=>f.search),['human edible products','human','edible','products'])
  assert.ok(requests.every(f=>!('#t'in f)&&!('until'in f)))
  assert.deepEqual(feed.listings().map(l=>l.identifier),['literal'])
  assert.equal(feed.queryPagination().error,'')
  feed.searchTags('leipä tuore');await feed.loadQueryCandidates()
  assert.ok(feed.listings().some(l=>l.identifier==='finnish'))
  assert.ok(feed.queryPlans.filter(p=>p.search).every(p=>p.indexHistory.exhausted))
 }finally{feed.close()}
})
test('no canned topic family exists; a loaded model can choose actual observed food tags without delaying initial keyword retrieval',async()=>{
 const tags=catalogue();assert.deepEqual(tags.select('human edible products'),['human edible products','human','edible','products'])
 assert.deepEqual(tags.select('electronics'),['electronics']);assert.deepEqual(tags.select('food'),['food'])
 const {feed,calls}=indexed();let resolve;const ai={enabled:()=>true,planTags:()=>new Promise(r=>resolve=r)}
 const discovery=createSearchDiscovery({getClient:()=>feed,getAI:()=>ai})
 try{
  discovery.update('human edible products','expanded');await tick()
  assert.ok(calls.some(f=>f.search==='human edible products'),'retrieval starts while planner remains unresolved')
  resolve(['meat','bread','invented']);await tick();await feed.loadQueryCandidates()
  assert.ok(feed.queryTags.includes('meat'));assert.ok(feed.queryTags.includes('bread'));assert.ok(!feed.queryTags.includes('invented'))
  assert.ok(feed.listings().some(l=>l.identifier==='meat'));assert.ok(feed.listings().some(l=>l.identifier==='bread'))
  assert.ok(!feed.listings().some(l=>['pet','pan'].includes(l.identifier)))
 }finally{discovery.dispose();feed.close()}
})
test('keyword rejection is quiet and clearing cancels a provider ignoring AbortSignal without deleting records',async()=>{
 let block=false;const calls=[]
 const feed=new MarketRelayClient({relays:[],now:()=>now,indexSearch:true,indexQuery:async filters=>{calls.push(filters[0]);if(block)return new Promise(()=>{});throw Error('unsupported')}}).start()
 try{
  feed.acceptListing(feed.parseIncoming(fixtures[0]));feed.searchTags('human edible products');await feed.loadQueryCandidates()
  assert.ok(feed.queryPagination().error,'tag error remains independently reportable')
  assert.ok(feed.listings().some(l=>l.identifier==='meat'))
  block=true;feed.searchTags('fresh bread');const pending=feed.loadQueryCandidates();await tick();const controller=feed.queryController
  feed.searchTags('');await pending;assert.equal(controller.signal.aborted,true);assert.equal(feed.queryPagination().hasMore,false)
  assert.equal(feed.listings().length,1)
 }finally{feed.close()}
})
class Relay{
 static calls=[];readyState=0
 constructor(url){this.url=url;queueMicrotask(()=>{this.readyState=1;this.onopen?.()})}
 send(raw){const frame=JSON.parse(raw);if(frame[0]!=='REQ')return;const f=frame[2];Relay.calls.push({url:this.url,filter:f});if(frame[1].startsWith('older-'))queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(['EOSE',frame[1]])}))}
 close(){this.readyState=3}
}
test('relay keyword reads omit tags and until; plan round robin stays within the shared cap across many relays',async()=>{
 Relay.calls=[];const feed=new MarketRelayClient({relays:Array.from({length:8},(_,i)=>`wss://r${i}.example`),WebSocketImpl:Relay,indexQuery:null,now:()=>now,tagCatalogue:catalogue()}).start()
 try{
  feed.searchTags('human edible products',['meat','bread'],'expanded');await feed.loadQueryCandidates()
  const targeted=Relay.calls.filter(c=>c.filter.limit===80)
  assert.equal(feed.queryRequestBudget.count,32);assert.equal(targeted.length,32)
  assert.ok(targeted.some(c=>c.filter['#t']?.includes('meat')))
  assert.ok(targeted.some(c=>c.filter.search==='human edible products'))
  assert.ok(targeted.filter(c=>c.filter.search).every(c=>!('#t'in c.filter)&&!('until'in c.filter)))
  assert.ok(new Set(targeted.map(c=>c.url)).size>=5)
  assert.equal(feed.queryPagination().limited,true)
 }finally{feed.close()}
})


test('silent or search-ignoring relays and rejecting index cannot block cached, generic or tag results',async()=>{
 class PartialRelay extends Relay{
  send(raw){const frame=JSON.parse(raw);if(frame[0]!=='REQ')return;const f=frame[2]
   queueMicrotask(()=>{
    const send=e=>this.onmessage?.({data:JSON.stringify(['EVENT',frame[1],e])})
    if(f.search){for(const e of fixtures)send(e);return} // ignores search, no EOSE
    if(!f['#t'])send(fixtures[5]);else if(f['#t'].includes('meat'))send(fixtures[0])
    this.onmessage?.({data:JSON.stringify(['EOSE',frame[1]])})
   })
  }
 }
 const indexCalls=[]
 const feed=new MarketRelayClient({relays:['wss://partial.example'],WebSocketImpl:PartialRelay,now:()=>now,tagCatalogue:catalogue(),indexQuery:async filters=>{indexCalls.push(filters[0]);if(filters[0].search)throw Error('search unsupported');return{events:[],complete:true}}}).start()
 try{
  feed.acceptListing(feed.parseIncoming(fixtures[1])) // already-cached verified record
  feed.searchTags('human edible products',['meat'],'expanded');const pending=feed.loadQueryCandidates()
  await new Promise(r=>setTimeout(r,40))
  assert.ok(feed.queryPromise,'silent optional source is still bounded/in flight')
  assert.deepEqual(new Set(feed.listings().map(l=>l.identifier)),new Set(['bread','meat','literal']))
  assert.equal(feed.queryPagination().error,'')
  feed.searchTags('');await pending
  assert.equal(feed.queryPagination().error,'');assert.equal(feed.listings().length,3)
  assert.ok(indexCalls.every(f=>!f.search),'Hashtree-style index is not sent unsupported search plans')
 }finally{feed.close()}
})


test('model refinement restarts interrupted keyword reads without resetting shared budgets',async()=>{
 const calls=[];let resolveFirst
 const feed=new MarketRelayClient({relays:[],now:()=>now,indexSearch:true,tagCatalogue:catalogue(),indexQuery:async filters=>{
  const f=filters[0];calls.push(f)
  if(f.search==='human edible products'&&calls.filter(c=>c.search===f.search).length===1)return new Promise(r=>resolveFirst=r)
  return{events:f.search?[fixtures[5]]:[],complete:true}
 }}).start()
 try{
  feed.searchTags('human edible products',undefined,'expanded');const old=feed.loadQueryCandidates();await tick()
  const count=feed.queryRequestBudget.count
  feed.searchTags('human edible products',['meat'],'expanded');await feed.loadQueryCandidates();await old
  assert.equal(calls.filter(f=>f.search==='human edible products').length,2)
  assert.ok(feed.queryRequestBudget.count>count);assert.ok(feed.listings().some(l=>l.identifier==='literal'))
  resolveFirst({events:[fixtures[4]],complete:true});await tick();assert.ok(!feed.listings().some(l=>l.identifier==='pan'))
 }finally{feed.close()}
})

test('a full ranked relay or index stream widens without a date cursor, then stops on a short page',async()=>{
 const fruit=Array.from({length:125},(_,i)=>signed('fruit-'+i,'Fruit '+i))
 for(const source of ['relay','index']){
   const limits=[]
   const results=filter=>{
     if(!filter.search)return []
     assert.equal(filter.until,undefined)
     limits.push(filter.limit);return fruit.slice(0,filter.limit)
   }
   class RankedRelay extends Relay{
     send(raw){
       const [command,id,filter]=JSON.parse(raw)
       if(command!=='REQ'||!id.startsWith('older-'))return
       queueMicrotask(()=>{
         for(const event of results(filter))this.onmessage?.({data:JSON.stringify(['EVENT',id,event])})
         this.onmessage?.({data:JSON.stringify(['EOSE',id])})
       })
     }
   }
   const options=source==='relay'?{relays:['wss://fruit.example'],WebSocketImpl:RankedRelay}:
     {relays:[],indexSearch:true,indexQuery:async ([filter])=>({events:results(filter),complete:true})}
   const feed=new MarketRelayClient({...options,browseDiscovery:true,now:()=>now}).start()
   try{
     const initial=source==='relay'?80:120
     feed.searchTags('fruit',[],'expanded')
     await feed.loadQueryCandidates();assert.equal(feed.listings().length,initial)
     await feed.loadQueryCandidates();assert.equal(feed.listings().length,125)
     await feed.loadQueryCandidates();assert.deepEqual(limits,[initial,initial*2])
     assert.equal(feed.queryPagination().hasMore,false)
   }finally{feed.close()}
 }
})

test('MiniLM plans a real relay word and observed tag without admitting unsigned listings or changing literal search',async()=>{
 const vectors=readTopicVectors(readFileSync(new URL('../assets/topic-vectors.bin',import.meta.url)));
 const plan=vectors('meat',['Beef','unrelated']);
 assert(plan.tags.includes('Beef'));assert(plan.terms.includes('beef'));assert(!plan.tags.includes('unrelated'));
 assert.deepEqual(vectors('unlistedword',['Beef']),{tags:[],terms:[]});
 const catalogue=new SeenTags(),seed=signed('seed','Example',['Beef']),beef=signed('cut','Beef brisket'),tagged=signed('roast','Sunday roast',['Beef']);
 const calls=[];
 const feed=new MarketRelayClient({relays:[],now:()=>now,indexSearch:true,tagCatalogue:catalogue,indexQuery:async([f])=>{
   calls.push(f);return{events:f.search==='beef'?[beef,{...beef,content:'tampered'}]:f['#t']?.includes('Beef')?[tagged]:[],complete:true};
 }}).start();
 const ai={enabled:()=>true,topicPlanning:()=>true};
 const discovery=createSearchDiscovery({getClient:()=>feed,getAI:()=>ai,planTopics:async(q,t)=>vectors(q,t)});
 try{
   discovery.update('meat','literal');await feed.loadQueryCandidates();
   assert(!calls.some(f=>f.search==='beef'));assert.equal(feed.listings().length,0);
   discovery.update('meat','expanded');await tick();await feed.loadQueryCandidates();
   assert(calls.some(f=>f.search==='beef'));assert.deepEqual(feed.listings().map(l=>l.identifier),['cut']);
   catalogue.observe(seed,now);discovery.update('meat','expanded');await tick();await feed.loadQueryCandidates();
   assert(calls.some(f=>f['#t']?.includes('Beef')));assert.deepEqual(feed.listings().map(l=>l.identifier).sort(),['cut','roast']);
   discovery.update('meat','literal');await feed.loadQueryCandidates();
   assert(!feed.queryPlans.some(p=>p.search==='beef'||p.tags.includes('Beef')));
 }finally{discovery.dispose();feed.close()}
});

test('a cold topic plan lets in-flight exact reads open before using the remaining budget',async()=>{
 const seen=[];let complete;
 const feed=new MarketRelayClient({relays:[],now:()=>now,indexSearch:true,tagCatalogue:catalogue(),indexQuery:async([f])=>{
   if(f.search)seen.push(f.search)
   if(f.search==='meat')return new Promise(resolve=>{complete=resolve})
   return{events:[],complete:true}
 }}).start()
 try{
   feed.searchTags('meat',undefined,'expanded');await tick()
   const exact=feed.loadQueryCandidates(),controller=feed.queryController,budget=feed.queryRequestBudget
   feed.searchTags('meat',[],'expanded',['beef'])
   assert.equal(controller.signal.aborted,false);assert.deepEqual(seen,['meat'])
   complete({events:[fixtures[0]],complete:true});await exact;await feed.loadQueryCandidates()
   assert.deepEqual(seen,['meat','beef']);assert.equal(feed.queryRequestBudget,budget)
   assert(feed.listings().some(l=>l.identifier==='meat'))
 }finally{feed.close()}
})
