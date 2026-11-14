import test from 'node:test';
import assert from 'node:assert/strict';
import {matchFilters,verifyEvent} from 'nostr-tools';
import {createMessaging} from '../src/messaging/client.ts';
import {createVault} from '../src/messaging/vault.ts';
function memory(){let row;return{read:async()=>structuredClone(row),write:async(next,expected)=>{if((row?.version??0)!==expected)throw Error('conflict');row=structuredClone(next);}};}
function relay(){const events=new Map(),subscriptions=new Set(),frames=[];return{frames,factory:()=>{const own=new Set();let closed=false;return{subscribe(filters,{onEvent}){const sub={filters,onEvent};subscriptions.add(sub);own.add(sub);queueMicrotask(()=>{if(!closed)for(const event of events.values())if(matchFilters(filters,event))onEvent(structuredClone(event));});return{close(){subscriptions.delete(sub);own.delete(sub);}};},async query(filters){return{events:[...events.values()].filter(event=>matchFilters(filters,event)),complete:true,sources:[]};},async publish(event){assert(verifyEvent(event));frames.push(structuredClone(event));events.set(event.id,structuredClone(event));for(const sub of subscriptions)if(matchFilters(sub.filters,event))queueMicrotask(()=>sub.onEvent(structuredClone(event)));return{remoteAccepted:true};},close(){closed=true;for(const sub of own)subscriptions.delete(sub);own.clear();}};}};}
const wait=async predicate=>{const until=Date.now()+7000;while(!predicate()){if(Date.now()>until)throw Error('Timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
test('real NDR exchanges delivered/seen and replacement reactions privately and survives account restore',async t=>{
 const bus=relay(),aStore=memory(),bStore=memory();const make=store=>createMessaging({vault:createVault({backend:store}),getRelays:()=>['wss://fixture.invalid'],transportFactory:bus.factory});const a=make(aStore),b=make(bStore);t.after(async()=>{await a.destroy();await b.destroy();});
 await a.createAccount();await b.createAccount();await wait(()=>a.state().canSend&&b.state().canSend);const alice=a.state().ownerPubkey,bob=b.state().ownerPubkey;
 const message=await a.send(bob,'Private reaction target');const aMessage=()=>a.state().conversations.find(c=>c.pubkey===bob)?.messages.find(m=>m.id===message);
 await wait(()=>aMessage()?.delivery==='delivered');await b.markSeen(alice,[message]);await wait(()=>aMessage()?.delivery==='seen');
 await b.react(alice,message,'👍');await wait(()=>aMessage()?.reactions?.[0]?.emoji==='👍');await b.react(alice,message,'❤️');await wait(()=>aMessage()?.reactions?.[0]?.emoji==='❤️');await b.react(alice,message,'❤️');await wait(()=>aMessage()?.reactions?.length===0);
 await a.lock();await a.unlock();await wait(()=>a.state().canSend);assert.equal(aMessage().delivery,'seen');assert.deepEqual(aMessage().reactions,[]);
 assert(bus.frames.every(event=>![7,14,15].includes(event.kind)));
 const privateEvents=bus.frames.filter(event=>[1059,1060].includes(event.kind));assert(privateEvents.length>0);assert(!JSON.stringify(privateEvents).includes('Private reaction target'));assert(!JSON.stringify(privateEvents).includes('❤️'));assert(privateEvents.every(event=>!event.tags.some(tag=>tag[0]==='p'&&[alice,bob].includes(tag[1]))));
 await b.setReceiptPreferences({delivered:false,seen:false});const second=await a.send(bob,'No receipts');await wait(()=>b.state().conversations.find(c=>c.pubkey===alice)?.messages.some(m=>m.id===second));await b.markSeen(alice,[second]);await new Promise(resolve=>setTimeout(resolve,80));assert.equal(a.state().conversations.find(c=>c.pubkey===bob).messages.find(m=>m.id===second).delivery,'sent');
});

test('actual NDR same-second batch and identical messages retain monotonic millisecond order across restore',async t=>{
 const bus=relay(),aStore=memory(),bStore=memory(),make=store=>createMessaging({vault:createVault({backend:store}),getRelays:()=>['wss://fixture.invalid'],transportFactory:bus.factory}),a=make(aStore),b=make(bStore);
 t.after(async()=>{await a.destroy();await b.destroy();});await a.createAccount();await b.createAccount();await wait(()=>a.state().canSend&&b.state().canSend);await b.setReceiptPreferences({delivered:false,seen:false});const alice=a.state().ownerPubkey,bob=b.state().ownerPubkey;
 const originalNow=Date.now,fixed=originalNow();const ids=[];
 try{Date.now=()=>fixed;for(let index=1;index<=35;index++)ids.push(await a.send(bob,`Batch ${index}`));ids.push(await a.send(bob,'Identical message'));ids.push(await a.send(bob,'Identical message'));}finally{Date.now=originalNow;}
 const own=()=>a.state().conversations.find(c=>c.pubkey===bob)?.messages||[],incoming=()=>b.state().conversations.find(c=>c.pubkey===alice)?.messages||[];
 await wait(()=>incoming().length===37);assert.equal(new Set(ids).size,37);assert.deepEqual(own().map(m=>m.id),ids);assert.deepEqual(incoming().map(m=>m.id),ids);assert(own().every((message,index)=>index===0||message.createdAtMs>own()[index-1].createdAtMs));
 await b.lock();await b.unlock();assert.deepEqual(incoming().map(m=>m.id),ids);assert(incoming().every(m=>typeof m.createdAtMs==='number'));
});

test('three profiles privately match pending entries through encrypted delivery after helper restart',async t=>{
  const bus=relay();
  const make=()=>createMessaging({vault:createVault({backend:memory()}),getRelays:()=>['wss://fixture.invalid'],transportFactory:bus.factory});
  const [buyer,seller,helper]=[make(),make(),make()];
  const profiles=[buyer,seller,helper];
  t.after(async()=>{for(const profile of profiles)await profile.destroy();});
  for(const profile of profiles)await profile.createAccount();
  await wait(()=>profiles.every(p=>p.state().canSend));
  for(const profile of profiles)await profile.privateMatch({op:'enable',enabled:true});
  const helperId=helper.state().ownerPubkey,buyerId=buyer.state().ownerPubkey,sellerId=seller.state().ownerPubkey;
  await buyer.privateMatch({op:'share',helper:helperId,side:'request',summary:'Seeking a cargo bike'});
  await seller.privateMatch({op:'share',helper:helperId,side:'offer',summary:'Spare cargo bike'});
  await wait(()=>Object.keys(helper.privateMatchView().received).length===2);
  await helper.lock();await helper.unlock();await wait(()=>helper.state().canSend);
  const entries=Object.keys(helper.privateMatchView().received);
  await helper.privateMatch({op:'suggest',left:entries[0],right:entries[1]});
  const [proposal]=Object.keys(helper.privateMatchView().pairs);
  await wait(()=>profiles.slice(0,2).every(p=>p.privateMatchView().interests[proposal]));
  await buyer.privateMatch({op:'vote',proposal,accept:true});
  await wait(()=>helper.privateMatchView().pairs[proposal].votes.includes(true));
  await assert.rejects(helper.privateMatch({op:'introduce',proposal}));
  await seller.privateMatch({op:'vote',proposal,accept:true});
  await wait(()=>helper.privateMatchView().pairs[proposal].votes.every(v=>v===true));
  await helper.privateMatch({op:'introduce',proposal});
  // Each person meets a per-match alias, never the other's account.
  const chat='match:'+proposal,people=[buyer,seller];
  await wait(()=>people.every(p=>p.privateMatchView().interests[proposal]?.chat===chat&&p.privateMatchChats()[0]?.connected));
  for(const p of people)assert.equal(p.privateMatchView().interests[proposal].contact,null);
  await seller.privateMatchSend(chat,'Still available');
  await wait(()=>buyer.privateMatchChats()[0].messages.some(m=>m.text==='Still available'));
  await buyer.privateMatchSend(chat,'Wonderful, thanks');
  await wait(()=>seller.privateMatchChats()[0].messages.some(m=>m.text==='Wonderful, thanks'&&!m.mine));
  await wait(()=>people.every(p=>p.privateMatchChats()[0].messages.every(m=>!m.mine||m.delivery==='sent')));
  for(const [me,other] of [[buyer,sellerId],[seller,buyerId]])
    assert(!JSON.stringify({state:me.state(),view:me.privateMatchView(),chats:me.privateMatchChats()}).includes(other));
  assert(bus.frames.every(e=>![14,30402,38383].includes(e.kind)));
  const encrypted=bus.frames.filter(e=>[1059,1060].includes(e.kind));
  assert(encrypted.length>0);
  for(const secret of ['cargo bike','Still available','Wonderful'])assert(!JSON.stringify(bus.frames).includes(secret));
  assert(bus.frames.filter(e=>[1059,1060].includes(e.kind)).every(e=>![buyerId,sellerId,helperId].includes(e.pubkey)));
  // An explicit reveal is signed by the profile key and verified by the other side.
  await buyer.privateMatch({op:'reveal',proposal});
  await wait(()=>seller.privateMatchView().interests[proposal].revealed===buyerId);
  assert.equal(buyer.privateMatchView().interests[proposal].shared_profile,true);
  assert.equal(seller.privateMatchView().interests[proposal].revealed,buyerId);
  assert.equal(buyer.privateMatchView().interests[proposal].revealed,null);
  assert(!JSON.stringify(bus.frames.filter(e=>[1059,1060].includes(e.kind))).includes(buyerId),'the reveal stays inside the encrypted chat');
  assert(encrypted.every(e=>!e.tags.some(([tag,key])=>tag==='p'&&[buyerId,sellerId,helperId].includes(key))));
});
