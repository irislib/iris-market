import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlaceSearch} from '../src/places/search.ts';

test('offline public city catalog remains searchable without location or provider calls',async()=>{
  let calls=0;const search=createPlaceSearch({source:{async search(){calls++;throw new Error('Offline');}}});
  assert.deepEqual(await search.search('H'),[]);assert.equal(calls,0);
  const matches=await search.search('Helsinki');assert.ok(matches.some(place=>place.name==='Helsinki'));
  assert.ok(matches.every(place=>Number.isFinite(place.lat)&&Number.isFinite(place.lng)));
  await search.close();assert.deepEqual(await search.search('Helsinki'),[]);
});
test('catalog query is bounded and successful street/POI results are retained',async()=>{
  let input,limit;const result={name:'Synthetic street',displayName:'Synthetic street',lat:60,lng:24,type:'street',class:'highway'};
  const search=createPlaceSearch({source:{async search(q,n){input=q;limit=n;return[result];}}});
  assert.deepEqual(await search.search('x'.repeat(200)),[result]);assert.equal(input.length,160);assert.equal(limit,8);await search.close();
});
test('slow catalog falls back without accepting late results after closing',async()=>{
  let finish;const search=createPlaceSearch({timeoutMs:5,source:{search:()=>new Promise(resolve=>{finish=resolve;})}});
  const result=await search.search('Helsinki');assert.ok(result.some(place=>place.name==='Helsinki'));await search.close();finish([]);
});
