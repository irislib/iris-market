import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,generateSecretKey} from 'nostr-tools';
import {createListingRecovery} from '../src/listing-recovery.ts';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const key=generateSecretKey();
const record=(name,tags=[],kind=30402)=>finalizeEvent({kind,created_at:100,content:name,tags:[['d',name],...tags]},key);

test('recovery seeds disk and streamed events before comparing, without blocking their caller',async()=>{
  let release;const order=[],subscriptions=[],streamed=record('streamed'),disk=record('disk');
  const recovery=createListingRecovery({readCache:()=>new Promise(resolve=>release=resolve),runtime:{
    async ingest(events){order.push(events.map(event=>event.id));},
    subscribe(filters,handlers){subscriptions.push({filters,handlers});order.push('compare');return{close(){}};},
  },onEvent(){}});
  try{
    const request=recovery.recover({kinds:[30402],until:100});recovery.observe(streamed);
    assert.deepEqual(order,[]);release([disk]);await request;
    assert.deepEqual(order,[[streamed.id,disk.id],'compare']);
    assert.deepEqual(subscriptions[0].filters,[{kinds:[30402],until:100,limit:1}]);
    recovery.observe(disk);await tick();assert.equal(order.length,2);
    await recovery.recover({kinds:[30402],until:100});assert.equal(subscriptions.length,1);
  }finally{recovery.close();}
});

test('failed cache import prevents empty-baseline comparison and private scopes are rejected',async()=>{
  let subscriptions=0;
  const recovery=createListingRecovery({readCache:async()=>[record('cached')],runtime:{async ingest(){throw Error('disk unavailable');},subscribe(){subscriptions++;return{close(){}};}},onEvent(){}});
  await recovery.recover({kinds:[30402]});await recovery.recover({kinds:[1059]});
  assert.equal(subscriptions,0);recovery.close();
});

test('closing cancels background subscriptions and ignores late recovered events',async()=>{
  let callback,stopped=0;const seen=[],missing=record('missing'),late=record('late');
  const recovery=createListingRecovery({readCache:async()=>[],runtime:{async ingest(){},subscribe(_filters,handlers){callback=handlers.onEvent;return{close(){stopped++;}};}},onEvent:event=>seen.push(event.id)});
  await recovery.recover({kinds:[30402]});callback(missing);recovery.close();callback(late);
  assert.deepEqual(seen,[missing.id]);assert.equal(stopped,1);
});

test('memory and disk baselines merge by signed event ID before comparison',async()=>{
  const memory=record('memory'),disk=record('disk'),shared=record('shared'),seen=[];
  const recovery=createListingRecovery({readCache:async()=>[disk,shared],readMemory:()=>[memory,shared],runtime:{
    async ingest(events){seen.push(...events.map(e=>e.id));},subscribe(){assert.equal(seen.length,3);return{close(){}};},
  },onEvent(){}});
  try {await recovery.recover({kinds:[30402]});assert.deepEqual(seen,[memory.id,shared.id,disk.id]);}
  finally {recovery.close();}
});

test('empty disk response retains actual memory baseline',async()=>{
  const memory=record('memory'),seen=[];
  const recovery=createListingRecovery({readCache:async()=>[],readMemory:()=>[memory],runtime:{
    async ingest(events){seen.push(...events.map(e=>e.id));},subscribe(){assert.deepEqual(seen,[memory.id]);return{close(){}};},
  },onEvent(){}});
  try {await recovery.recover({kinds:[30402]});assert.deepEqual(seen,[memory.id]);}
  finally {recovery.close();}
});

test('expired authority stays with Market and is not claimed as shared-worker inventory',async()=>{
  const expired=record('expired',[['expiration','200']]),live=record('live',[['expiration','201']]),badExpiry=record('bad',[['expiration','x']]);
  const forged={...record('forged'),content:'changed'},privateEvent=record('private',[],1059),seen=[];
  const recovery=createListingRecovery({now:()=>200000,readCache:async()=>[expired,live,badExpiry,forged,privateEvent],readMemory:()=>[expired],runtime:{
    async ingest(events){seen.push(...events.map(e=>e.id));},subscribe(){return{close(){}};},
  },onEvent(){}});
  try {await recovery.recover({kinds:[30402]});recovery.observe(expired);await tick();assert.deepEqual(seen,[live.id]);}
  finally {recovery.close();}
});

test('closing while reading disk cannot start late imports or subscriptions',async()=>{
  let release,imports=0,subscriptions=0;
  const recovery=createListingRecovery({readCache:()=>new Promise(resolve=>release=resolve),readMemory:()=>[record('memory')],runtime:{
    async ingest(){imports++;},subscribe(){subscriptions++;return{close(){}};},
  },onEvent(){}});
  const pending=recovery.recover({kinds:[30402]});recovery.close();release([record('disk')]);await pending;
  assert.equal(imports,0);assert.equal(subscriptions,0);
});

test('each new comparison includes newly added memory records',async()=>{
  const first=record('first'),second=record('second'),seen=[];let memory=[first];
  const recovery=createListingRecovery({readCache:async()=>[],readMemory:()=>memory,runtime:{
    async ingest(events){seen.push(...events.map(e=>e.id));},subscribe(){return{close(){}};},
  },onEvent(){}});
  try {await recovery.recover({kinds:[30402],until:100});memory=[first,second];await recovery.recover({kinds:[30402],until:101});assert.deepEqual(seen,[first.id,second.id]);}
  finally {recovery.close();}
});

test('duplicate IDs skip rereading payload after verification',async()=>{
  const event=record('duplicate');let reads=0;
  const duplicate={...event,get tags(){reads++;throw Error('duplicate body must not be read');}};
  const recovery=createListingRecovery({readCache:async()=>[event],runtime:{async ingest(){},subscribe(){return{close(){}};}},onEvent(){}});
  try {recovery.observe(event);recovery.observe(duplicate);assert.equal(reads,0);await recovery.recover({kinds:[30402]});recovery.observe(duplicate);assert.equal(reads,0);}
  finally {recovery.close();}
});

test('large baseline verification yields before importing and preserves live arrivals',async()=>{
  const baseline=Array.from({length:70},(_,i)=>record(`baseline-${i}`)),late=record('late'),seen=[];let timerRan=false;
  const recovery=createListingRecovery({readCache:async()=>baseline,runtime:{
    async ingest(events){assert.equal(timerRan,true);seen.push(...events.map(e=>e.id));},subscribe(){return{close(){}};},
  },onEvent(){}});
  setTimeout(()=>{timerRan=true;recovery.observe(late);},0);
  try {await recovery.recover({kinds:[30402]});assert.equal(seen.length,71);assert.ok(seen.includes(late.id));}
  finally {recovery.close();}
});
