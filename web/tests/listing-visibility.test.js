import test from 'node:test';
import assert from 'node:assert/strict';
import {createHiddenListings,wantsPhotos} from '../src/listing-visibility.ts';
const home={saved:false,map:false,query:'',side:'offer',category:'all',location:'',shipsTo:'',tags:[],authors:null,network:false};
test('photo defaults affect only the entry feed, with explicit include/exclude choices',()=>{
  assert.equal(wantsPhotos(null,home),true);
  for(const state of [{saved:true},{map:true},{query:'chair'},{side:'request'},{category:'Transport'},{location:'Helsinki'},{shipsTo:'FI'},{tags:['chair']},{authors:['seller']},{network:true}]){
    assert.equal(wantsPhotos(null,{...home,...state}),false);
    assert.equal(wantsPhotos(true,{...home,...state}),true);
  }
  assert.equal(wantsPhotos(false,home),false);
});
test('hidden coordinates persist across reload and edits without changing saved state',()=>{
  const data=new Map(),storage={getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};
  const saved=new Set(['seller:chair']),hidden=createHiddenListings(storage,'live');
  hidden.hide('seller:chair');assert(hidden.has('seller:chair'));assert(saved.has('seller:chair'));
  const restored=createHiddenListings(storage,'live');assert(restored.has('seller:chair'));
  assert.equal(createHiddenListings(storage,'preview').count(),0);
  restored.show('seller:chair');assert.equal(restored.count(),0);
  restored.hide('seller:table');restored.clear();assert.equal(createHiddenListings(storage,'live').count(),0);
});
test('storage failure never claims a listing has been hidden; records are bounded',()=>{
  const blocked=createHiddenListings({getItem(){return '[]'},setItem(){throw Error('quota')}},'live');
  assert.throws(()=>blocked.hide('seller:chair'),/quota/);assert.equal(blocked.count(),0);
  const full=createHiddenListings({getItem:()=>JSON.stringify(Array.from({length:2000},(_,i)=>String(i))),setItem(){}},'live');
  assert.equal(full.count(),1000);assert.throws(()=>full.hide('new'),/Restore/);
  full.show('0');full.hide('new');assert.equal(full.count(),1000);
});
