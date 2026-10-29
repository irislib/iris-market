import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { AppKeys } from 'nostr-double-ratchet';
import { createMessaging, canPublishToDevice } from '../src/messaging/client.ts';
import { createVault } from '../src/messaging/vault.ts';
import { prepareSignerAuthorization } from '../src/messaging/authorization.ts';
import { buildReviewDraft } from '../src/reviews.ts';

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

test('public review is durable before silent relays reply, isolated from private messages and restored exactly', {timeout:3000},async t=>{
  const backend=memoryBackend(),network=silentNetwork(),vault=createVault({backend}),app=make(vault,network);t.after(()=>app.destroy());
  const created=await app.createAccount(),target=getPublicKey(generateSecretKey());
  const draft=buildReviewDraft({target,author:created.ownerPubkey,rating:4,body:'Carefully packed.'});
  const receipt=await app.publishEvent(draft),id=receipt.event.id;
  assert.equal(receipt.delivery,'queued');assert.deepEqual(receipt.accepted,[]);
  assert.equal((await vault.get(`market/public/${id}`)).id,id);assert.equal(app.state().pendingReviews[0].id,id);
  assert.equal(JSON.stringify(await backend.read()).includes('Carefully packed.'),false);
  receipt.event.tags.find(tag=>tag[0]==='body')[1]='Mutated receipt';
  const view=app.state();view.pendingReviews[0].tags.find(tag=>tag[0]==='body')[1]='Mutated state';
  assert.equal(app.state().pendingReviews[0].tags.find(tag=>tag[0]==='body')[1],'Carefully packed.');
  assert.deepEqual(app.state().conversations,[]);assert.deepEqual(app.state().orders,[]);
  await app.lock();const restored=await app.restore();assert.equal(restored.pendingReviews[0].id,id);
  assert.equal(restored.pendingReviews[0].tags.find(tag=>tag[0]==='body')[1],'Carefully packed.');
  assert.deepEqual(restored.conversations,[]);assert.deepEqual(restored.orders,[]);
});

test('review allowlist rejects private payloads, forged signers and unsupported facts before queuing or signing', {timeout:3000},async t=>{
  const network=silentNetwork(),vault=createVault({backend:memoryBackend()}),app=make(vault,network);t.after(()=>app.destroy());
  const state=await app.createAccount(),key=nip19.decode(app.exportKey()).data,target=getPublicKey(generateSecretKey());
  const draft=buildReviewDraft({target,author:state.ownerPubkey,rating:5});
  for(const changed of [{...draft,content:'private message'},{...draft,tags:[...draft.tags,['shipment','private route']]},{...draft,kind:14},{...draft,kind:1059}]){
    await assert.rejects(app.publishSignedEvent(finalizeEvent(changed,key)),/Invalid public account event/);
  }
  await assert.rejects(app.publishSignedEvent(finalizeEvent(draft,generateSecretKey())),/Invalid public account event/);
  await assert.rejects(app.signEvent({...draft,tags:[...draft.tags,['location','60,24']]}),/Unsupported review fields/);
  assert.deepEqual(app.state().pendingReviews,[]);
  // A signed but unsupported record left in storage must not be re-published on restore.
  const invalid=finalizeEvent({...draft,content:'private message'},key);
  await vault.put(`market/public/${invalid.id}`,invalid);await app.lock();await app.restore();
  assert.deepEqual(app.state().pendingReviews,[]);assert.equal(network.calls.some(call=>call.kind==='publish'&&call.value.id===invalid.id),false);
});

test('delivery and listing persist as one local publication before relay work and survive reopening', {timeout:3000}, async t=>{
  const network=silentNetwork(),backend=memoryBackend(),vault=createVault({backend}),app=make(vault,network);t.after(()=>app.destroy());
  await app.createAccount();
  const option=await app.signEvent({kind:30406,created_at:Math.floor(Date.now()/1000),content:'',tags:[['d','post'],['title','Delivery'],['price','5','EUR'],['country','FI'],['service','standard']]});
  const item=await app.signEvent({...listing,tags:[...listing.tags,['shipping_option',`30406:${option.pubkey}:post`]]});
  const receipts=await app.publishSignedEvents([option,item]);assert.equal(receipts.length,2);assert(receipts.every(receipt=>receipt.delivery==='queued'));
  for(const event of [option,item])assert.equal((await vault.get(`market/public/${event.id}`)).id,event.id);
  await app.lock();await app.restore();assert.equal(app.state().pendingListings[0].id,item.id);assert.equal((await vault.get(`market/public/${option.id}`)).id,option.id);
  const invalid=await app.signEvent({...option,kind:30406,tags:[['d','invalid']]});
  await assert.rejects(app.publishSignedEvents([invalid,item]),/Invalid public account event/);
});

test('a failed atomic batch storage write leaves neither event locally queued',async()=>{
  const backend=memoryBackend(),vault=createVault({backend});await vault.create();
  const original=backend.write;backend.write=async()=>{throw Error('disk unavailable');};
  await assert.rejects(vault.putMany([['market/public/option',{id:'option'}],['market/public/item',{id:'item'}]]));
  assert.equal(await vault.get('market/public/option'),undefined);assert.equal(await vault.get('market/public/item'),undefined);
  backend.write=original;
});

test('background publication cannot see either delivery event before the whole pair is durable', {timeout:3000}, async t=>{
  const vault=createVault({backend:memoryBackend()}),save=vault.putMany.bind(vault);let pairDurable=false,observed=0;
  vault.putMany=async entries=>{await save(entries);if(entries.some(([,event])=>event.kind===30406)){assert.equal(entries.length,2);pairDurable=true;}};
  const app=createMessaging({vault,getRelays:()=>[],transportFactory:()=>({query:async()=>({events:[],complete:true}),publish:async event=>{if([30402,30406].includes(event.kind)){assert(pairDurable);observed++;}return {remoteAccepted:true,accepted:[]};},subscribe:()=>({close(){}}),close(){}})});t.after(()=>app.destroy());
  await app.createAccount();
  const option=await app.signEvent({kind:30406,created_at:Math.floor(Date.now()/1000),content:'',tags:[['d','atomic'],['title','Delivery'],['price','0','EUR'],['country','FI'],['service','standard']]});
  const item=await app.signEvent({...listing,tags:[...listing.tags,['shipping_option',`30406:${option.pubkey}:atomic`]]});
  await app.publishSignedEvents([option,item]);await waitFor(()=>observed===2);
});
