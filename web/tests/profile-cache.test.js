import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,getPublicKey} from 'nostr-tools/pure';
import {createProfileHeadCache,PROFILE_CACHE_LIMITS} from '../src/profile-cache.ts';
import {verifyProfileRecord} from '../src/profiles.ts';
const secret=new Uint8Array(32).fill(51),key=getPublicKey(secret),other=getPublicKey(new Uint8Array(32).fill(52));
const event=(content,at=1700000000)=>finalizeEvent({kind:0,created_at:at,tags:[],content},secret);
const memory=(value=null)=>({getItem:()=>value,setItem:(_key,next)=>{value=next},value:()=>value});
const cache=storage=>createProfileHeadCache({storage,validate:verifyProfileRecord});

test('signed startup heads survive reload and newer empty/unsupported metadata prevents rollback',()=>{
  const storage=memory(),first=cache(storage),older=event('{"name":"Before","picture":"https://example.com/avatar.png"}'),newer=event('not-json',1700000001);
  assert(first.observe(older));first.flush();assert.equal(cache(storage).read(key).id,older.id);
  assert(first.observe(newer));first.flush();const reopened=cache(storage);
  assert.equal(reopened.read(key).id,newer.id);assert.equal(reopened.observe(older),false);reopened.flush();assert.equal(cache(storage).read(key).id,newer.id);
});
test('untrusted cached records are verified per object, not just a copied event id',()=>{
  const valid=event('{"name":"Real"}'),forged={...valid,pubkey:other,content:'{"name":"Forged"}'};
  const storage=memory(JSON.stringify({version:1,events:[valid,forged]})),heads=cache(storage);
  assert.equal(heads.read(key).id,valid.id);assert.equal(heads.read(other),null);
  assert.throws(()=>heads.observe({...valid,content:'tampered'}));
});
test('saving a visible profile retains unrelated cached heads for later screens',()=>{
  const second=finalizeEvent({kind:0,created_at:1700000000,tags:[],content:'{"name":"Other"}'},new Uint8Array(32).fill(52));
  const storage=memory(JSON.stringify({version:1,events:[event('{"name":"Before"}'),second]})),heads=cache(storage);
  heads.observe(event('{"name":"After"}',1700000001));heads.flush();assert.equal(cache(storage).read(other).id,second.id);
});
test('valid signed heads remain within the cumulative startup-cache byte budget',()=>{
  const storage=memory(),heads=cache(storage),records=[];
  for(let i=1;i<=42;i++){
    const signed=finalizeEvent({kind:0,created_at:1700000000,tags:Array.from({length:500},()=>['x','a'.repeat(100)]),content:'{"name":"Cached"}'},new Uint8Array(32).fill(i));
    records.push(signed);heads.observe(signed);
  }
  heads.flush();assert(Buffer.byteLength(storage.value())<=PROFILE_CACHE_LIMITS.bytes);
  assert.equal(heads.read(records[0].pubkey),null);assert.equal(cache(storage).read(records.at(-1).pubkey).id,records.at(-1).id);
});
test('malformed, oversized and unavailable storage cannot supply names or block live heads',()=>{
  for(const value of ['broken',JSON.stringify({version:1,events:Array(PROFILE_CACHE_LIMITS.records+1).fill(event('{}'))}),'x'.repeat(PROFILE_CACHE_LIMITS.bytes+1)])assert.equal(cache(memory(value)).read(key),null);
  const heads=cache({getItem(){throw Error('Unavailable')},setItem(){throw Error('Quota')}}),valid=event('{"name":"Live"}');
  assert(heads.observe(valid));assert.doesNotThrow(()=>heads.flush());assert.equal(heads.read(key).id,valid.id);
  assert.throws(()=>heads.observe(event('x'.repeat(PROFILE_CACHE_LIMITS.eventBytes))),/Invalid cached profile/);
});
