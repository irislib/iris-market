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

test('failed catalog with no bundled match rejects instead of reporting no matches',async()=>{
  const failure=new Error('Catalog download failed');
  const search=createPlaceSearch({source:{async search(){throw failure;}}});
  await assert.rejects(search.search('Synthetic absent place'),error=>error===failure);
  await search.close();
});
test('timed out catalog with no bundled match rejects but successful empty search is empty',async()=>{
  const slow=createPlaceSearch({timeoutMs:5,source:{search:()=>new Promise(()=>{})}});
  await assert.rejects(slow.search('Synthetic absent place'),/Place search unavailable/);await slow.close();
  const empty=createPlaceSearch({source:{async search(){return[];}}});
  assert.deepEqual(await empty.search('Synthetic absent place'),[]);await empty.close();
});
test('record cache shares failure, preserves it, and retries on the next lookup',async()=>{
  const {createAsyncCache}=await import('../src/places/asyncCache.ts');
  let calls=0;const failure=new Error('Record unavailable');
  const read=createAsyncCache(async()=>{calls++;if(calls===1)throw failure;return 'record';},key=>key);
  const first=read('cid');assert.equal(read('cid'),first);
  await assert.rejects(first,error=>error===failure);
  assert.equal(await read('cid'),'record');assert.equal(calls,2);
});

test('index term download failures remain observable despite index library error swallowing',async()=>{
  const {createMapPlaceSearchSource}=await import('../src/places/index.ts');
  const {default:manifest}=await import('../src/places/manifest.json',{with:{type:'json'}});
  const failure=new Error('Catalog block download failed');
  const source=createMapPlaceSearchSource(manifest,{store:{async get(){throw failure;},async has(){return false;},async put(){return false;},async delete(){return false;}}});
  await assert.rejects(source.search('Synthetic absent place',8),error=>error===failure);
});
