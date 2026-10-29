import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,generateSecretKey,getPublicKey,matchFilters} from 'nostr-tools';
import {COUNTRY_CODES,SHIPPING_LIMITS,countryCode,createShippingResolver,matchesShippingDestination,parseShippingReference} from '../src/shipping.ts';
import {parseEvent} from '../src/market.ts';

const key=generateSecretKey(),other=generateSecretKey(),author=getPublicKey(key),foreign=getPublicKey(other),now=1800000000;
const sign=(kind,tags,at=now-10,signer=key,content='')=>finalizeEvent({kind,tags,created_at:at,content},signer);
const ref=(d='post',owner=author,kind=30406)=>`${kind}:${owner}:${d}`;
const option=(d='post',tags=[],at=now-10,signer=key)=>sign(30406,[['d',d],['title','Tracked post'],['price','5.50','EUR'],['country','FI','SE'],['service','standard'],...tags],at,signer);
const listing=(tags=[],d='item')=>parseEvent(sign(30402,[['d',d],['title','Bicycle'],['location','Finland'],...tags]),{now});
function fixture(initial=[]){let events=initial;const calls=[];const query=async(filters,options)=>{calls.push({filters,options});return{events:events.filter(event=>matchFilters(filters,event)),complete:true};};return{resolver:createShippingResolver({query,now:()=>now}),calls,set:next=>{events=next}};}
const get=(report,item)=>report.byListing.get(item.id);

test('explicit delivery countries are validated and product location never becomes shipping coverage',async()=>{
  assert.equal(COUNTRY_CODES.length,249);assert.equal(new Set(COUNTRY_CODES).size,249);
  assert.equal(countryCode(' fi '),'FI');assert.equal(countryCode('XX'),null);
  const item=listing([['shipping_option',ref()]]),local=listing([],'local'),{resolver,calls}=fixture([option()]);
  const result=await resolver.load([item,local]);
  assert.deepEqual(get(result,item).destinations,['FI','SE']);assert(matchesShippingDestination(get(result,item),'fi'));
  assert.equal(matchesShippingDestination(get(result,item),'US'),false);
  assert.deepEqual(get(result,local).destinations,[]);assert.equal(get(result,local).unknown,true);
  assert.equal(matchesShippingDestination(get(result,local),'FI'),false);
  assert.equal(matchesShippingDestination(get(result,local),'FI',{includeUnknown:true}),true);
  assert.equal(matchesShippingDestination(get(result,local),'XX',{includeUnknown:true}),false);
  assert(calls.every(call=>call.filters.every(filter=>filter.authors.every(value=>value===author))));
  assert.equal(result.incomplete,false);assert.equal(result.hasMore,false);
});

test('pickup remains separate from delivery and country-level matches retain regional constraints',async()=>{
  const pickup=sign(30406,[['d','pickup'],['title','Pickup'],['price','0','EUR'],['country','FI'],['service','pickup'],['location','Helsinki']]);
  const item=listing([['shipping_option',ref('pickup')]]),f=fixture([pickup]);
  let info=get(await f.resolver.load([item]),item);assert.equal(info.pickupAvailable,true);assert.deepEqual(info.destinations,[]);assert.equal(info.options[0].pickupLocation,'Helsinki');assert.equal(matchesShippingDestination(info,'FI'),false);
  const restricted=option('regional',[['region','FI-18']]),regional=listing([['shipping_option',ref('regional')]],'regional');
  f.set([restricted]);info=get(await f.resolver.load([regional]),regional);assert.deepEqual(info.options[0].regions,['FI-18']);assert(matchesShippingDestination(info,'FI'));
});

test('explicit collection inheritance supports one hop and never follows generic collection membership or nested references',async()=>{
  const collection=sign(30405,[['d','summer'],['title','Summer'],['shipping_option',ref('third',foreign)],['shipping_option',ref('nested',foreign,30405)]]);
  const item=listing([['shipping_option',ref('summer',author,30405)]]),membership=listing([['a',ref('summer',author,30405)]],'member');
  const f=fixture([collection,option('third',[],now-10,other),sign(30405,[['d','nested'],['title','Must not query']],now-10,other)]);
  const result=await f.resolver.load([item,membership]);assert.deepEqual(get(result,item).destinations,['FI','SE']);assert.equal(get(result,item).unknown,true);
  assert.equal(get(result,membership).unknown,true);assert.deepEqual(get(result,membership).options,[]);
  assert.equal(f.calls.flatMap(call=>call.filters).some(filter=>filter['#d']?.includes('nested')),false);
  assert(f.calls.flatMap(call=>call.filters).some(filter=>filter.kinds.includes(30406)&&filter.authors.includes(foreign)));
});

test('signature, exact referenced signer and d-tag are checked again even with a cached verification symbol',async()=>{
  const own=option(),forged={...own,tags:own.tags.map(tag=>tag[0]==='country'?['country','US']:tag)};
  const item=listing([['shipping_option',ref()]]);
  const resolver=createShippingResolver({now:()=>now,query:async()=>({events:[forged,option('post',[],now,other),option('unreferenced')],complete:true})});
  const info=get(await resolver.load([item]),item);assert.deepEqual(info.options,[]);assert.equal(info.unknown,true);
  assert.equal(parseShippingReference(`30406:${author}:bad\nref`),null);assert.equal(parseShippingReference(`1059:${author}:private`),null);
});

test('winning expired, disabled and unsupported revisions suppress older shipping across later relay replays',async()=>{
  const item=listing([['shipping_option',ref()]]),old=option('post',[],now-30);
  for(const revision of [option('post',[['expiration',String(now-1)]],now-20),option('post',[['status','inactive']],now-20),option('post',[['country','US']],now-20)]){
    const f=fixture([old,revision]);let result=await f.resolver.load([item]);assert.deepEqual(get(result,item).destinations,[]);
    f.set([old]);result=await f.resolver.load([item],{refresh:true});assert.deepEqual(get(result,item).destinations,[]);
  }
});

test('equal timestamp revisions use the lowest event id and caller mutation cannot corrupt cached options',async()=>{
  const first=option('post',[],now-10),second=sign(30406,[['d','post'],['title','Delivery'],['price','0','USD'],['country','US'],['service','express']],now-10),winner=[first,second].sort((a,b)=>a.id.localeCompare(b.id))[0];
  const item=listing([['shipping_option',ref()]]),f=fixture([second,first]);
  const info=get(await f.resolver.load([item]),item);assert.equal(info.options[0].eventId,winner.id);
  info.options[0].countries.push('AU');info.destinations.push('AU');assert.equal(matchesShippingDestination(f.resolver.forListing(item),'AU'),false);
});

test('same-owner address and exact-id deletions are applied regardless of result order and retained on replay',async()=>{
  const item=listing([['shipping_option',ref()]]),old=option('post',[],now-30);
  for(const tag of [['a',ref()],['e',old.id]]){
    const deletion=sign(5,[tag],now-20),f=fixture([deletion,old]);
    let info=get(await f.resolver.load([item]),item);assert.deepEqual(info.options,[]);assert.equal(info.unknown,false);
    f.set([old]);info=get(await f.resolver.load([item],{refresh:true}),item);assert.deepEqual(info.options,[]);
    const fresh=option('post',[],now-5);f.set([fresh]);info=get(await f.resolver.load([item],{refresh:true}),item);assert.equal(info.options[0].eventId,fresh.id);
  }
  const f=fixture([old,sign(5,[['a',ref()],['e',old.id]],now,other)]);
  assert.equal(get(await f.resolver.load([item]),item).options[0].eventId,old.id);
});

test('a deleted collection never causes a request to its former third-party shipping provider',async()=>{
  const collection=sign(30405,[['d','old'],['title','Old'],['shipping_option',ref('third',foreign)]],now-30);
  const item=listing([['shipping_option',ref('old',author,30405)]]),f=fixture([collection,sign(5,[['e',collection.id]],now-20),option('third',[],now-10,other)]);
  const result=await f.resolver.load([item]);assert.deepEqual(get(result,item).options,[]);assert.equal(get(result,item).unknown,false);
  assert.equal(f.calls.some(call=>call.filters.some(filter=>filter.authors.includes(foreign))),false);
});

test('bounded follow-up loads advance past the first reference batch without querying already fresh records',async()=>{
  const items=Array.from({length:70},(_,index)=>listing([['shipping_option',ref(`option-${index}`)]],`item-${index}`)),f=fixture(items.map((_,index)=>option(`option-${index}`)));
  const first=await f.resolver.load(items);assert.equal(first.hasMore,true);assert.equal(first.limited,true);assert.equal([...first.byListing.values()].filter(info=>info.options.length).length,SHIPPING_LIMITS.references);
  const count=f.calls.length,second=await f.resolver.load(items);assert.equal(second.hasMore,false);assert.equal([...second.byListing.values()].filter(info=>info.options.length).length,70);
  assert.equal(f.calls.slice(count).flatMap(call=>call.filters).filter(filter=>filter.kinds.includes(30406)).length,6);
  const loaded=f.calls.length;await f.resolver.load(items);assert.equal(f.calls.length,loaded);
  for(const call of f.calls){assert(call.filters.length<=64);assert(call.options.limit<=512);assert(call.options.deadline>Date.now()-10000);}
});

test('explicit refresh clears lookup freshness without discarding signed winners or deletion tombstones',async()=>{
  const item=listing([['shipping_option',ref()]]),old=option('post',[],now-30),f=fixture([old]);
  await f.resolver.load([item]);const count=f.calls.length;
  const changed=sign(30406,[['d','post'],['title','US delivery'],['price','0','USD'],['country','US'],['service','standard']],now-20);
  f.set([changed]);await f.resolver.load([item]);assert.equal(f.calls.length,count);assert.deepEqual(f.resolver.forListing(item).destinations,['FI','SE']);
  f.resolver.invalidate();assert.deepEqual(f.resolver.forListing(item).destinations,['FI','SE']);
  let result=await f.resolver.load([item]);assert.deepEqual(get(result,item).destinations,['US']);assert(f.calls.length>count);
  f.set([sign(5,[['a',ref()]],now-10),changed]);f.resolver.invalidate();await f.resolver.load([item]);assert.deepEqual(f.resolver.forListing(item).options,[]);
  f.set([old]);f.resolver.invalidate();result=await f.resolver.load([item]);assert.deepEqual(get(result,item).options,[]);
});

test('explicit refresh retries a recently failed lookup instead of treating its grace period as completion',async()=>{
  const item=listing([['shipping_option',ref()]]);let fail=true,calls=0;
  const resolver=createShippingResolver({now:()=>now,query:async filters=>{calls++;if(fail)throw Error('Temporary relay error');return{events:[option()].filter(event=>matchFilters(filters,event)),complete:true};}});
  await assert.rejects(resolver.load([item]),/Temporary/);const count=calls;
  fail=false;await resolver.load([item]);assert.equal(calls,count);assert.equal(resolver.forListing(item).unknown,true);
  resolver.invalidate();const result=await resolver.load([item]);assert.deepEqual(get(result,item).destinations,['FI','SE']);
});

test('missing references stay unknown with honest incomplete status and a cancelled silent query settles promptly',async()=>{
  const item=listing([['shipping_option',ref()]]),resolver=createShippingResolver({now:()=>now,query:async()=>({events:[],complete:false})});
  const result=await resolver.load([item]);assert.equal(result.incomplete,true);assert.equal(get(result,item).unknown,true);
  assert.equal((await resolver.load([item])).incomplete,true);
  const controller=new AbortController();let querySignal;
  const silent=createShippingResolver({now:()=>now,query:async(_filters,options)=>{querySignal=options.signal;return new Promise(()=>{});}});
  const pending=silent.load([item],{signal:controller.signal});controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(querySignal.aborted,true);
  await assert.rejects(silent.load([item],{signal:controller.signal}),{name:'AbortError'});
});

test('an empty reference set performs no queries and unsupported wide responses are bounded',async()=>{
  let calls=0;const resolver=createShippingResolver({now:()=>now,query:async()=>{calls++;return{events:[],complete:true};}});
  await resolver.load([listing()]);assert.equal(calls,0);
  const item=listing([['shipping_option',ref()]]),large={...option(),content:'x'.repeat(SHIPPING_LIMITS.eventBytes+1)};
  const malicious=createShippingResolver({now:()=>now,query:async()=>({events:[large],complete:true})});
  const result=await malicious.load([item]);assert.equal(result.limited,true);assert.deepEqual(get(result,item).options,[]);
});
