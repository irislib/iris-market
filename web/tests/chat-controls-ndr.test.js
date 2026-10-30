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
