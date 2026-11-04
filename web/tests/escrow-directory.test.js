import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,generateSecretKey} from 'nostr-tools/pure';
import {findEscrowServices,advertisedProviders} from '../src/escrow-directory.ts';
import {readProfileMetadata} from '../src/profiles.ts';
import {parseEvent} from '../src/market.ts';

test('cold provider search fetches signed service ads and only their public profiles',async()=>{
  const key=generateSecretKey(), now=Math.floor(Date.now()/1000),dir=new Map(),requests=[];
  const ad=(date,status='active')=>finalizeEvent({kind:30402,created_at:date,content:'Public service',
    tags:[['d','service'],['title','Escrow services'],['market','offer'],['status',status],['t','escrow-provider']]},key);
  const old=ad(now-20),closed=ad(now-10,'sold'),bad={...old,content:'Changed after signing'};
  const meta=finalizeEvent({kind:0,tags:[],created_at:now,content:JSON.stringify({name:'Rowan'})},key);
  const runtime={query:async filters=>{requests.push(filters);return {events:[bad,old]};},subscribe(filters,events){
    requests.push(filters);events.onEvent(meta);events.onEose({sources:[{complete:true}]});return {close(){}};
  }};
  await findEscrowServices(dir,['wss://example.test'],runtime);
  assert.deepEqual([...advertisedProviders([],dir)],[old.pubkey]);
  assert.deepEqual(requests[0],[{kinds:[30402],'#t':['escrow-provider'],limit:48}]);
  assert.deepEqual(requests[1][0].authors,[old.pubkey]);
  assert.equal(readProfileMetadata(old.pubkey,{relays:['wss://example.test']}).name,'Rowan');
  assert.deepEqual([...advertisedProviders([parseEvent(closed)],dir)],[]);
  await findEscrowServices(dir,['wss://example.test'],{query:async()=>({events:[closed]})});
  assert.deepEqual([...advertisedProviders([parseEvent(old)],dir)],[]);
});
