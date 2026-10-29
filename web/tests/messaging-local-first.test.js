import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { AppKeys } from 'nostr-double-ratchet';
import { createMessaging, canPublishToDevice } from '../src/messaging/client.ts';
import { createVault } from '../src/messaging/vault.ts';
import { prepareSignerAuthorization } from '../src/messaging/authorization.ts';

function memoryBackend() {
  let row;
  return {read:async()=>structuredClone(row),write:async(value,expected)=>{if(expected!==undefined&&(row?.version??0)!==expected)throw new Error('Another writer');row=structuredClone(value);}};
}
function silentNetwork() {
  const calls=[];
  const pending=(kind,value,{signal}={})=>{calls.push({kind,value});return new Promise((_,reject)=>{if(signal?.aborted)reject(signal.reason);else signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});});};
  return {calls,factory:()=>({query:(filters,options)=>pending('query',filters,options),publish:(event,options)=>pending('publish',event,options),subscribe:()=>({close(){}}),close(){}})};
}
const waitFor=async predicate=>{const deadline=Date.now()+1500;while(!predicate()){if(Date.now()>deadline)throw new Error('Local state did not settle');await new Promise(resolve=>setTimeout(resolve,5));}};
const make=(vault,network)=>createMessaging({vault,getRelays:()=>['wss://silent.invalid'],transportFactory:network.factory});
const listing={kind:30402,created_at:1,tags:[['d','offline-listing'],['title','Bicycle']],content:'Available locally'};

test('new profile, name, listing and conversation persist while every relay stays silent', {timeout:3000}, async t=>{
  const network=silentNetwork(),vault=createVault({backend:memoryBackend()}),app=make(vault,network);
  t.after(()=>app.destroy());
  const created=await app.createAccount();
  assert.equal(created.status,'ready');assert.equal(created.canSign,true);assert.equal(created.error,'');
  await app.updateProfile({name:'Taylor'});
  const receipt=await app.publishEvent(listing);
  assert.equal(receipt.delivery,'queued');assert.deepEqual(receipt.accepted,[]);
  const peer=getPublicKey(generateSecretKey());await app.open(peer);
  await waitFor(()=>app.state().canSend);
  const stored=await vault.get('market/account');
  assert.ok(stored.proof);assert.equal(stored.installed,true);
  assert.ok(await vault.get(`market/public/${stored.proof.id}`));
  assert.equal(app.state().displayName,'Taylor');
  assert.equal(network.calls.some(call=>call.kind==='query'&&call.value[0]?.kinds?.includes(37368)),false);
  await app.lock();const restored=await app.restore();
  assert.equal(restored.status,'ready');assert.equal(restored.canSign,true);assert.equal(restored.needsLogin,false);
  assert.equal(restored.ownerPubkey,created.ownerPubkey);assert.equal(restored.displayName,'Taylor');
  assert.ok(restored.conversations.some(chat=>chat.pubkey===peer));
  assert.equal(restored.pendingListings[0].id,receipt.event.id);
  restored.pendingListings[0].content='tampered view';
  assert.equal(app.state().pendingListings[0].content,receipt.event.content);
  assert.equal(JSON.parse(restored.profileEvent.content).name,'Taylor');
  assert.equal((await vault.get(`market/public/${receipt.event.id}`)).id,receipt.event.id);
  assert.equal(network.calls.some(call=>call.kind==='publish'&&[1059,1060].includes(call.value.kind)),false);
});

for(const hasPreparedProof of [false,true])test(`legacy incomplete local profile restores without discovery (${hasPreparedProof?'saved proof':'no proof'})`,{timeout:2000},async t=>{
  const key=generateSecretKey(),owner=getPublicKey(key),device=generateSecretKey(),network=silentNetwork(),vault=createVault({backend:memoryBackend()});
  const proof=hasPreparedProof?finalizeEvent(prepareSignerAuthorization(owner,getPublicKey(device),null),key):undefined;
  await vault.create({'market/account':{owner,mode:'local',installed:false,ownerSecret:Array.from(key),deviceSecret:Array.from(device),...(proof?{proof}:{})}});vault.lock();
  const app=make(vault,network);t.after(()=>app.destroy());
  const restored=await app.restore();
  assert.equal(restored.status,'ready');assert.equal(restored.canSign,true);assert.equal(restored.canSend,false);assert.equal(restored.needsLogin,false);assert.equal(restored.error,'');
  assert.equal(restored.devicePubkey,getPublicKey(device));assert.equal(app.exportKey(),nip19.nsecEncode(key));
  await app.updateProfile({name:'Already here'});
  const receipt=await app.publishEvent(listing);assert.equal(receipt.delivery,'queued');
  await app.lock();assert.equal((await app.restore()).displayName,'Already here');
  assert.equal((await vault.get(`market/public/${receipt.event.id}`)).id,receipt.event.id);
  assert.equal(network.calls.some(call=>call.kind==='publish'&&[1059,1060].includes(call.value.kind)),false);
});

test('queued public publication keeps its exact event across restart until acknowledged', {timeout:3000},async t=>{
  let accepted=false;const attempts=[];
  const network={factory:()=>({query:async()=>({events:[],complete:true,sources:[]}),subscribe:()=>({close(){}}),publish:async event=>{attempts.push(event.id);return {remoteAccepted:accepted};},close(){}})};
  const vault=createVault({backend:memoryBackend()}),app=make(vault,network);t.after(()=>app.destroy());
  await app.createAccount();const receipt=await app.publishEvent(listing);
  await waitFor(()=>attempts.includes(receipt.event.id));
  assert.ok(await vault.get(`market/public/${receipt.event.id}`));assert.equal(receipt.delivery,'queued');
  await app.lock();accepted=true;await app.restore();
  await waitFor(()=>app.state().pendingPublic===0);
  assert.equal(await vault.get(`market/public/${receipt.event.id}`),undefined);
  assert.ok(attempts.filter(id=>id===receipt.event.id).length>=2);
});

test('unknown or revoked destination devices never receive queued ciphertext',()=>{
  const owner='1'.repeat(64),device='2'.repeat(64),event={kind:1060,tags:[['p',device]]};
  const context={recipientOwnerPubkey:owner};
  assert.equal(canPublishToDevice(event,context,[]),false);
  assert.equal(canPublishToDevice(event,undefined,[]),false);
  assert.equal(canPublishToDevice(event,context,[{ownerPubkey:owner,appKeys:new AppKeys([])}]),false);
});
