import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {validateProfileBootstrap,seedProfileMetadata} from '../src/profile-bootstrap.ts';
import {cacheProfileMetadata,readProfileMetadata,clearProfileCache} from '../src/profiles.ts';
const secret=new Uint8Array(32).fill(61),key=getPublicKey(secret);
const record=(content,at=1700000000)=>finalizeEvent({kind:0,created_at:at,tags:[],content},secret);

test('checked-in public bootstrap has exact reviewed bytes and only authenticated unique profile heads',async()=>{
  const bytes=await readFile(new URL('../src/data/profile-bootstrap.json',import.meta.url));
  const provenance=JSON.parse(await readFile(new URL('../src/data/profile-bootstrap.provenance.json',import.meta.url),'utf8'));
  assert.equal(bytes.length,provenance.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),provenance.sha256);
  const records=validateProfileBootstrap(JSON.parse(bytes));assert.equal(records.length,provenance.profiles);assert(records.length>0);
  assert.equal(new Set(records.map(event=>event.pubkey)).size,records.length);
});
test('bootstrap rejects forged records, duplicates, unrelated kinds and excessive input',()=>{
  const valid=record('{"name":"Name"}');
  assert.throws(()=>validateProfileBootstrap({version:1,events:[{...valid,content:'forged'}]}));
  assert.throws(()=>validateProfileBootstrap({version:1,events:[valid,valid]}));
  assert.throws(()=>validateProfileBootstrap({version:1,events:[finalizeEvent({kind:3,created_at:1700000000,tags:[],content:''},secret)]}));
  assert.throws(()=>validateProfileBootstrap({version:1,events:Array(257).fill(valid)}));
});
test('a signed unsupported revision remains a head and cannot restore an older name',()=>{
  clearProfileCache();const relays=['wss://bootstrap-order.example'],old=record('{"name":"Before"}'),latest=record('invalid JSON',1700000001);
  cacheProfileMetadata(latest,{relays});
  for(const event of validateProfileBootstrap({version:1,events:[old]}))cacheProfileMetadata(event,{relays});
  assert.notEqual(readProfileMetadata(key,{relays}).name,'Before');
});
test('bootstrap loading is cancellable before projecting any public metadata',async()=>{
  const controller=new AbortController();controller.abort();let progress=0;
  await assert.rejects(seedProfileMetadata({signal:controller.signal,onProgress(){progress++}}),{name:'AbortError'});assert.equal(progress,0);
});
test('the lazy bootstrap verifies its runtime digest and seeds metadata in bounded batches',async()=>{
  clearProfileCache();const relays=['wss://bootstrap-seed.example'],input=JSON.parse(await readFile(new URL('../src/data/profile-bootstrap.json',import.meta.url),'utf8'));let updates=0;
  const count=await seedProfileMetadata({relays,onProgress(){updates++}});
  assert.equal(count,input.events.length);assert(updates>1);
  assert.equal(readProfileMetadata(input.events[0].pubkey,{relays}).eventId,input.events[0].id);
});
