import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {watchProfileMetadata,readProfileMetadata,clearProfileCache,PROFILE_LIMITS} from '../src/profiles.ts';
const secret=new Uint8Array(32).fill(73),key=getPublicKey(secret),other=getPublicKey(new Uint8Array(32).fill(74)),now=1700000000;
const signed=(name,at=now)=>finalizeEvent({kind:0,created_at:at,tags:[],content:JSON.stringify({name})},secret);
function fixture(options={}) {
 clearProfileCache();let handlers,closed=0;const changes=[],relays=['wss://live-profile.example'];
 const runtime={subscribe(filters,next){assert.deepEqual(filters,[{kinds:[0],authors:[key],limit:2}]);handlers=next;return{close(){closed++}}},query(){assert.fail('Live metadata must not duplicate its shared subscription with a finite query')}};
 const watch=watchProfileMetadata([key],{relays,runtime,now:()=>now,onChange:p=>changes.push(p.name),...options});
 return{watch,changes,handlers,closed:()=>closed,read:()=>readProfileMetadata(key,{relays})};
}
test('a delayed admitted profile repaints after historical timeout without querying again',()=>{
 const f=fixture();try{
  f.handlers.onEose?.({complete:false,reason:'timeout',sources:[]});
  assert.equal(f.closed(),0);assert.equal(f.read().metadataFound,false);
  f.handlers.onEvent(signed('Zaza'),{source:'relay',cached:false});
  assert.equal(f.read().name,'Zaza');assert.deepEqual(f.changes,['Zaza']);
 }finally{f.watch.close()}assert.equal(f.closed(),1);
});
test('live metadata preserves latest signed winners and unsupported revisions',()=>{
 const f=fixture();try{
  const current=signed('Current');f.handlers.onEvent(current);
  f.handlers.onEvent({...signed('Forged',now+1),content:'{"name":"Tampered"}'});
  f.handlers.onEvent({...signed('Other',now+1),pubkey:other});f.handlers.onEvent(signed('Older',now-1));
  assert.equal(f.read().name,'Current');assert.deepEqual(f.changes,['Current']);
  const unsupported=finalizeEvent({kind:0,created_at:now+1,tags:[],content:'not JSON'},secret);
  f.handlers.onEvent(unsupported);f.handlers.onEvent(current);
  assert.equal(f.read().metadataFound,false);assert.equal(f.changes.length,2);
 }finally{f.watch.close()}
});
test('abort and bounded lifetime close subscriptions and reject late deliveries',async()=>{
 const controller=new AbortController(),f=fixture({signal:controller.signal});controller.abort();f.handlers.onEvent(signed('Too late'));assert.equal(f.closed(),1);assert.equal(f.read().metadataFound,false);
 const expiring=fixture({lifetimeMs:5});await new Promise(resolve=>setTimeout(resolve,15));assert.equal(expiring.closed(),1);expiring.watch.close();assert.equal(expiring.closed(),1);
});
test('metadata streams stop at their frame budget even for repeated untrusted records',()=>{
 const f=fixture();for(let i=0;i<=PROFILE_LIMITS.queryEvents;i++)f.handlers.onEvent({kind:0});assert.equal(f.closed(),1);f.handlers.onEvent(signed('Too late'));assert.equal(f.read().metadataFound,false);
});
