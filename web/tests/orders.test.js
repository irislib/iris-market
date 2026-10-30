import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, matchFilters, verifyEvent } from 'nostr-tools';
import { createVault } from '../src/messaging/vault.ts';
import { createMessaging } from '../src/messaging/client.ts';
import {contextTags,messageContext,orderContext,messageThreadKey,listingContext} from '../src/message-context.ts';
import { applyOrderEnvelope, createOrderBook, decodeOrder, LOCATION_TTL, ORDER_TAG } from '../src/orders.ts';

const buyer='1'.repeat(64),seller='2'.repeat(64),courier='3'.repeat(64),outsider='4'.repeat(64),device='5'.repeat(64);
const listing={id:`${seller}:bicycle`,author:seller,title:'Bicycle',price:'125',currency:'EUR',side:'offer',status:'active'};
function backend(){let row;return {read:async()=>structuredClone(row),write:async(value,expected)=>{if((row?.version??0)!==expected)throw Error('conflict');row=structuredClone(value);}};}
async function book(owner,{now=()=>1800000000,store,deviceKey=device,developerMint}={}){const memory=store??backend(),vault=createVault({backend:memory});if(!(await vault.status()).exists)await vault.create();else await vault.unlock();const result=createOrderBook({vault,owner,device:deviceKey,now,developerMint});await result.load();const receive=result.receive;result.receive=(rumor,sender,fromDevice=device)=>receive(rumor,sender,fromDevice);return {book:result,vault,backend:memory};}
const eventFor=(book,action)=>decodeOrder(book.jobs().findLast(job=>job.action===action).rumor);
const rumorFor=(book,action,peer)=>book.jobs().findLast(job=>job.action===action&&(!peer||job.recipient===peer)).rumor;
async function participants(){const a=await book(buyer),b=await book(seller),c=await book(courier);const order=await a.book.request(listing);await b.book.receive(rumorFor(a.book,'request'),buyer);await b.book.update(order.id,{status:'accepted'});await a.book.receive(rumorFor(b.book,'status'),seller);await b.book.update(order.id,{shipment:{stops:[{id:'pickup',label:'Pickup',address:'Private pickup',courierPubkey:courier,coordinates:[24.94,60.17]},{id:'drop',label:'Delivery',address:'Private destination',courierPubkey:courier}],eta:1800003600}});await a.book.receive(rumorFor(b.book,'route',buyer),seller);await c.book.receive(rumorFor(b.book,'route',courier),seller);return {a,b,c,id:order.id};}

test('request and exact outgoing rumors are one encrypted durable mutation, restored before any connection',async()=>{
 const a=await book(buyer);const order=await a.book.request(listing,{quantity:2,note:'Call on arrival'});
 assert.equal(order.status,'requested');assert.equal(order.sync,'queued');assert.equal(order.items[0].quantity,2);
 const jobs=a.book.jobs();assert.equal(jobs.length,1);assert.equal(jobs[0].recipient,seller);assert.equal(jobs[0].rumor.kind,14);
 assert.equal(decodeOrder(jobs[0].rumor).id,order.id);assert.match(jobs[0].rumor.content,/2 × Bicycle/);
 assert(!JSON.stringify(await a.backend.read()).includes('Call on arrival'));
 a.vault.lock();const restored=await book(buyer,{store:a.backend});assert.deepEqual(restored.book.jobs(),jobs);assert.equal(restored.book.state()[0].id,order.id);
 await restored.book.archive(order.id,true);assert.equal(restored.book.state()[0].archived,true);assert.equal(restored.book.jobs().length,1);
 await restored.book.sent(jobs[0].id,buyer);assert.equal(restored.book.state()[0].sync,'queued');
 await restored.book.sent(jobs[0].id,seller);assert.equal(restored.book.state()[0].sync,'sent');
});

test('storage failure cannot expose an order or a half-written outgoing queue',async()=>{
 const a=await book(buyer);a.vault.put=async()=>{throw Error('full')};
 await assert.rejects(a.book.request(listing),/full/);assert.deepEqual(a.book.state(),[]);assert.deepEqual(a.book.jobs(),[]);
});

test('authenticated parties, explicit seller routing, and courier assignments are required',async()=>{
 const {a,b,c,id}=await participants();
 assert.equal(c.book.state()[0].role,'courier');assert.equal(c.book.state()[0].shipment.stops.length,2);
 const request=rumorFor(a.book,'request');const outsiderBook=await book(outsider);
 assert.equal(await outsiderBook.book.receive(request,buyer),null);
 assert.equal(await b.book.receive(request,outsider),null);
 assert.equal(await outsiderBook.book.receive(rumorFor(b.book,'route',courier),seller),null);
 await assert.rejects(c.book.update(id,{status:'cancelled'}),/Couriers/);
 await assert.rejects(a.book.update(id,{shipment:{stops:[]}}),/accepted order/);
 await c.book.update(id,{stopId:'pickup',status:'arrived'});const update=rumorFor(c.book,'stop',buyer);
 assert.equal(await a.book.receive(update,outsider),null);assert.equal(await a.book.receive(update,undefined),null);
 assert.equal((await a.book.receive(update,courier)).orderId,id);assert.equal(a.book.state()[0].shipment.stops[0].status,'arrived');
 assert.equal(await a.book.receive(update,courier),null);
 await assert.rejects(c.book.update(id,{stopId:'pickup',status:'pending'}),/Invalid delivery/);
});

test('new seller state restores route after reordering and previous courier route cannot authorize new updates',async()=>{
 const {a,b,c,id}=await participants();
 await c.book.update(id,{stopId:'pickup',status:'arrived'});const stale=rumorFor(c.book,'stop',buyer);
 await b.book.update(id,{shipment:{stops:[{id:'pickup',label:'Pickup',address:'Elsewhere',courierPubkey:outsider}]}});
 const route=rumorFor(b.book,'route',buyer);
 await b.book.update(id,{status:'in-transit'});const later=rumorFor(b.book,'status',buyer);
 await a.book.receive(later,seller);assert.equal(a.book.state()[0].shipment.stops[0].courierPubkey,outsider);
 assert.equal(await a.book.receive(route,seller),null);assert.equal(await a.book.receive(stale,courier),null);
 const newCourier=await book(outsider);assert.equal(await newCourier.book.receive(route,courier),null);assert((await newCourier.book.receive(route,seller)).orderId===id);
});

test('locations keep only latest position, expire outgoing updates, clear explicitly, and never change order roles',async()=>{
 let clock=1800000000;const {a,b,c,id}=await participants();
 await c.book.update(id,{location:{stopId:'pickup',coordinates:[24.9,60.1]}});const first=c.book.jobs().filter(job=>job.action==='location');
 await c.book.update(id,{location:{stopId:'pickup',coordinates:[25,60.2]}});const latest=c.book.jobs().filter(job=>job.action==='location');
 assert.equal(latest.length,2);assert(first.every(job=>!c.book.canPublish(job.id)));
 assert(!JSON.stringify(c.book.jobs()).includes('24.9'));
 assert((await a.book.receive(latest[0].rumor,courier)).location);assert.deepEqual(a.book.state()[0].shipment.location.coordinates,[25,60.2]);
 await c.book.update(id,{location:null});assert(latest.every(job=>!c.book.canPublish(job.id)));
 await a.book.receive(rumorFor(c.book,'location',buyer),courier);assert.equal(a.book.state()[0].shipment.location,undefined);
 const timed=await book(courier,{now:()=>clock});await timed.book.receive(rumorFor(b.book,'route',courier),seller);
 await timed.book.update(id,{location:{stopId:'pickup',coordinates:[25,60.2]}});const old=timed.book.jobs()[0];clock+=LOCATION_TTL;
 assert.equal(timed.book.canPublish(old.id),false);await timed.book.prune();assert.equal(timed.book.jobs().length,0);assert.equal(timed.book.state()[0].locationFresh,false);
 await b.book.update(id,{status:'cancelled'});await a.book.receive(rumorFor(b.book,'status',buyer),seller);assert.equal(a.book.state()[0].status,'cancelled');assert.equal(a.book.state()[0].shipment.location,undefined);
 await assert.rejects(b.book.update(id,{status:'accepted'}),/finished/);
});

test('malformed, oversized, future, and changed-party envelopes cannot alter private orders',async()=>{
 const {a,b,id}=await participants();const raw=rumorFor(b.book,'route',buyer),event=decodeOrder(raw);
 for(const mutate of [value=>{value.snapshot.buyer=outsider;},value=>{value.at+=301;},value=>{value.payload.stops=Array(13).fill(value.payload.stops[0]);},value=>{value.payload.trackingUrl='javascript:alert(1)';}]){
  const bad=structuredClone(event);bad.seq+=100;mutate(bad);const rumor={...raw,tags:[[ORDER_TAG,'1',JSON.stringify(bad)]]};assert.equal(await a.book.receive(rumor,seller),null);
 }
 assert.equal(decodeOrder({...raw,tags:[[ORDER_TAG,'1','x'.repeat(24001)]]}),null);
 assert.equal(decodeOrder({...raw,tags:[]}),null);
 assert.equal(a.book.state()[0].id,id);
 assert.throws(()=>a.book.request({...listing,author:buyer,id:`${buyer}:self`}),/identity/);
 assert.throws(()=>a.book.request(listing,{quantity:1000}),/quantity/);
});

test('stop sharing arriving before a location suppresses that older position',async()=>{
 const {a,c,id}=await participants();
 await c.book.update(id,{location:{stopId:'pickup',coordinates:[24.9,60.1]}});const sample=rumorFor(c.book,'location',buyer);
 await c.book.update(id,{location:null});const stopped=rumorFor(c.book,'location',buyer);
 assert((await a.book.receive(stopped,courier)).location);
 assert.equal(await a.book.receive(sample,courier),null);assert.equal(a.book.state()[0].shipment.location,undefined);
});

test('route before acceptance and replies before the sibling request are applied without role shortcuts',async()=>{
 const a=await book(buyer),b=await book(seller),sibling=await book(buyer,{deviceKey:'6'.repeat(64)});
 const order=await a.book.request(listing);await b.book.receive(rumorFor(a.book,'request'),buyer);
 await b.book.update(order.id,{status:'accepted'});const accept=rumorFor(b.book,'status',buyer);
 await b.book.update(order.id,{shipment:{stops:[{id:'pickup',label:'Pickup',address:'Private',courierPubkey:courier}]}});const route=rumorFor(b.book,'route',buyer);
 await a.book.receive(route,seller);assert.equal(a.book.state()[0].status,'accepted');assert.equal(a.book.state()[0].shipment.stops.length,1);
 assert.equal(await a.book.receive(accept,seller),null);
 assert.equal(await sibling.book.receive(route,seller),null);assert.equal(await sibling.book.receive(accept,seller),null);assert.equal(sibling.book.state().length,0);
 await sibling.book.receive(rumorFor(a.book,'request'),buyer);assert.equal(sibling.book.state()[0].status,'accepted');assert.equal(sibling.book.state()[0].shipment.stops.length,1);
 await a.book.update(order.id,{status:'cancelled'});const cancel=rumorFor(a.book,'status',seller);
 const lateSeller=await book(seller);assert.equal(await lateSeller.book.receive(cancel,buyer),null);await lateSeller.book.receive(rumorFor(a.book,'request'),buyer);assert.equal(lateSeller.book.state()[0].status,'cancelled');
});

test('separate authenticated devices do not collide on their local order sequence',async()=>{
 const {a,b,c,id}=await participants(),second=await book(courier,{deviceKey:'7'.repeat(64)});
 await second.book.receive(rumorFor(b.book,'route',courier),seller);
 await c.book.update(id,{stopId:'pickup',status:'arrived'});await second.book.update(id,{stopId:'drop',status:'arrived'});
 await a.book.receive(rumorFor(c.book,'stop',buyer),courier,device);
 await a.book.receive(rumorFor(second.book,'stop',buyer),courier,'7'.repeat(64));
 assert.deepEqual(a.book.state()[0].shipment.stops.map(stop=>stop.status),['arrived','arrived']);
});

test('an out-of-order dependency is not acknowledged when its durable write fails',async()=>{
 const a=await book(buyer),b=await book(seller),sibling=await book(buyer);
 const order=await a.book.request(listing);await b.book.receive(rumorFor(a.book,'request'),buyer);
 await b.book.update(order.id,{status:'accepted'});const reply=rumorFor(b.book,'status',buyer);
 const put=sibling.vault.put;sibling.vault.put=async()=>{throw Error('storage full')};
 await assert.rejects(sibling.book.receive(reply,seller),/storage full/);
 sibling.vault.put=put;await sibling.book.receive(reply,seller);
 await sibling.book.receive(rumorFor(a.book,'request'),buyer);assert.equal(sibling.book.state()[0].status,'accepted');
});

function relay(){const events=new Map(),subscriptions=new Set(),frames=[];let online=true,publishHook;return {frames,set online(value){online=value},set publishHook(value){publishHook=value},factory:()=>{const own=new Set();return {
 subscribe(filters,{onEvent}){const sub={filters,onEvent};own.add(sub);subscriptions.add(sub);queueMicrotask(()=>{for(const event of events.values())if(matchFilters(filters,event))onEvent(structuredClone(event));});return{close(){own.delete(sub);subscriptions.delete(sub)}};},
 async query(filters){return {events:[...events.values()].filter(event=>matchFilters(filters,event)).map(event=>structuredClone(event)),complete:true};},
 async publish(event){if(!online)throw Error('offline');if(publishHook)await publishHook(event);assert(verifyEvent(structuredClone(event)));frames.push(structuredClone(event));events.set(event.id,structuredClone(event));for(const sub of subscriptions)if(matchFilters(sub.filters,event))queueMicrotask(()=>sub.onEvent(structuredClone(event)));return {remoteAccepted:true};},
 close(){for(const sub of own)subscriptions.delete(sub);own.clear();}
 };}};}
const waitFor=async predicate=>{const deadline=Date.now()+12000;while(!await predicate()){if(Date.now()>deadline)throw Error('Condition timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
function app(bus){const vault=createVault({backend:backend()}),client=createMessaging({vault,getRelays:()=>['wss://test.invalid'],transportFactory:bus.factory});client.testVault=vault;return client;}

test('actual NDR runtimes exchange buyer/seller/courier orders privately; locations never enter chat', {timeout:45000},async t=>{
 const bus=relay(),buyerApp=app(bus),sellerApp=app(bus),courierApp=app(bus);const apps=[buyerApp,sellerApp,courierApp];
 t.after(async()=>{for(const app of apps)await app.destroy();});
 for(const app of apps)await app.createAccount();await waitFor(()=>apps.every(app=>app.state().canSend));
 const owner=sellerApp.state().ownerPubkey,courierOwner=courierApp.state().ownerPubkey;
 const requested=await buyerApp.requestOrder({...listing,author:owner,id:`${owner}:bike`},{note:'Private order note'});
 assert.equal(requested.sync,'queued');await waitFor(()=>sellerApp.state().orders.length===1);
 await sellerApp.updateOrder(requested.id,{status:'accepted'});await waitFor(()=>buyerApp.state().orders[0].status==='accepted');
 await sellerApp.updateOrder(requested.id,{shipment:{stops:[{id:'pick',label:'Pickup',address:'Private address',courierPubkey:courierOwner}]}});
 await waitFor(()=>courierApp.state().orders.length===1&&buyerApp.state().orders[0].shipment.stops.length===1);
 await courierApp.updateOrder(requested.id,{stopId:'pick',status:'arrived'});await waitFor(()=>buyerApp.state().orders[0].shipment.stops[0].status==='arrived');
 // Order state commits before its ordinary chat projection; wait for the
 // arrival message before measuring whether the later location adds a row.
 await waitFor(()=>buyerApp.state().conversations.some(chat=>chat.messages.some(message=>message.orderId===requested.id&&message.text==='Delivery stop arrived for Bicycle.')));
 const before=buyerApp.state().conversations.reduce((sum,chat)=>sum+chat.messages.length,0);
 await courierApp.updateOrder(requested.id,{location:{stopId:'pick',coordinates:[24.1234,60.2345]}});await waitFor(()=>buyerApp.state().orders[0].shipment.location);
 assert.equal(buyerApp.state().conversations.reduce((sum,chat)=>sum+chat.messages.length,0),before);
 assert(buyerApp.state().conversations.some(chat=>chat.messages.some(message=>message.orderId===requested.id)));
 assert(!bus.frames.some(event=>JSON.stringify(event).includes('Private address')||JSON.stringify(event).includes('Private order note')||JSON.stringify(event).includes('24.1234')));
 assert(bus.frames.filter(event=>event.kind===1060).every(event=>event.tags.some(tag=>tag[0]==='v'&&tag[1]==='2')));
 bus.online=false;
 await courierApp.updateOrder(requested.id,{location:{stopId:'pick',coordinates:[25.6789,61.9876]}});
 await waitFor(async()=>{const rows=await Promise.all((await courierApp.testVault.list()).map(key=>courierApp.testVault.get(key)));return JSON.stringify(rows).includes('25.6789');});
 await courierApp.updateOrder(requested.id,{location:null});
 await waitFor(async()=>{const rows=await Promise.all((await courierApp.testVault.list()).map(key=>courierApp.testVault.get(key)));return !JSON.stringify(rows).includes('25.6789');});
 bus.online=true;
 await waitFor(()=>buyerApp.state().orders[0].sync==='sent');
 await buyerApp.lock();assert.deepEqual(buyerApp.state().orders,[]);await buyerApp.unlock();assert.equal(buyerApp.state().orders[0].id,requested.id);await waitFor(()=>buyerApp.state().canSend);
 await buyerApp.send(owner,'ordinary message');await waitFor(()=>sellerApp.state().conversations.some(chat=>chat.messages.some(message=>message.text==='ordinary message')));assert.equal(sellerApp.state().orders.length,1);
});

test('ready profile queues an order without chat authorization or relay completion and restores it', {timeout:10000},async t=>{
 const never=()=>new Promise(()=>{}),vault=createVault({backend:backend()});const key=generateSecretKey();
 await vault.create({'market/account':{owner:getPublicKey(key),mode:'local',ownerSecret:Array.from(key),deviceSecret:Array.from(generateSecretKey()),installed:false,displayName:'Local Buyer'}});vault.lock();
 const client=createMessaging({vault,getRelays:()=>['wss://silent.invalid'],transportFactory:()=>({subscribe:()=>({close(){}}),query:never,publish:never,close(){}})});
 t.after(()=>client.destroy());await client.restore();assert.equal(client.state().status,'ready');assert.equal(client.state().canSend,false);
 const order=await Promise.race([client.requestOrder(listing),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Order waited on network')),1000);timer.unref?.();})]);
 assert.equal(order.sync,'queued');assert.equal(client.state().displayName,'Local Buyer');
 await client.lock();await client.unlock();assert.equal(client.state().orders[0].id,order.id);assert.equal(client.state().orders[0].sync,'queued');
});

test('a sender sibling acknowledgement cannot mark the seller delivery sent', {timeout:45000},async t=>{
 const bus=relay(),first=app(bus),sibling=app(bus),sellerApp=app(bus);let releaseCopy;
 const copyGate=new Promise(resolve=>{releaseCopy=resolve});let copying=false;
 t.after(async()=>{releaseCopy();bus.publishHook=undefined;for(const value of [first,sibling,sellerApp])await value.destroy();});
 await first.createAccount();await waitFor(()=>first.state().canSend);
 await sibling.loginWithKey({key:first.exportKey()});await sellerApp.createAccount();
 await waitFor(()=>[first,sibling,sellerApp].every(value=>value.state().canSend)&&first.state().devices.length===2);
 bus.publishHook=async event=>{if(event.kind!==1060)return;const recipient=event.tags.find(tag=>tag[0]==='p')?.[1];if(recipient===sellerApp.state().devicePubkey)throw Error('seller unavailable');if(recipient===sibling.state().devicePubkey){copying=true;await copyGate;}};
 const owner=sellerApp.state().ownerPubkey,order=await first.requestOrder({...listing,author:owner,id:`${owner}:ack-test`});
 await waitFor(()=>copying&&first.state().conversations.some(chat=>chat.messages.some(message=>message.orderId===order.id)));
 releaseCopy();await waitFor(()=>sibling.state().orders.some(item=>item.id===order.id));
 assert.equal(first.state().orders[0].sync,'queued');
 assert.equal(first.state().conversations.find(chat=>chat.pubkey===owner).messages.find(message=>message.orderId===order.id).delivery,'queued');
});


test('real order-book IDs survive private request and reply context and reject nonparticipants',{timeout:45000},async t=>{
 const bus=relay(),buyerApp=app(bus),sellerApp=app(bus),outsiderApp=app(bus),apps=[buyerApp,sellerApp,outsiderApp];
 t.after(async()=>{for(const client of apps)await client.destroy();});
 for(const client of apps)await client.createAccount();await waitFor(()=>apps.every(client=>client.state().canSend));
 const buyerOwner=buyerApp.state().ownerPubkey,sellerOwner=sellerApp.state().ownerPubkey,outsiderOwner=outsiderApp.state().ownerPubkey;
 // requestOrder uses the production createOrderBook, including its established buyerHex:UUID identity.
 const requested=await buyerApp.requestOrder({...listing,author:sellerOwner,id:`${sellerOwner}:context-bike`});
 await waitFor(()=>sellerApp.state().orders.some(order=>order.id===requested.id));
 assert.ok(requested.id.startsWith(buyerOwner+':'));
 const context=orderContext(requested.id);assert.equal(context.thread_id,requested.id.slice(65));assert.deepEqual(messageContext(contextTags(context)),context);
 const inquiry='Synthetic order-specific inquiry';await buyerApp.send(sellerOwner,inquiry,context);
 await waitFor(()=>sellerApp.state().conversations.some(chat=>chat.messages.some(message=>message.text===inquiry)));
 const received=sellerApp.state().conversations.flatMap(chat=>chat.messages).find(message=>message.text===inquiry);
 assert.deepEqual(received.context,context);assert.equal(messageThreadKey(received),`order:${requested.id}`);
 const reply='Synthetic reply in the same order';await sellerApp.send(buyerOwner,reply,received.context);
 await waitFor(()=>buyerApp.state().conversations.some(chat=>chat.messages.some(message=>message.text===reply)));
 const response=buyerApp.state().conversations.flatMap(chat=>chat.messages).find(message=>message.text===reply);
 assert.deepEqual(response.context,context);assert.equal(response.orderId,requested.id);
 await assert.rejects(buyerApp.send(outsiderOwner,'Must not escape the order participants',context),/not shared/);
 await assert.rejects(outsiderApp.send(buyerOwner,'Cannot claim an unrelated order',context),/not shared/);
 assert(!bus.frames.some(event=>JSON.stringify(event).includes(requested.id)||JSON.stringify(event).includes(inquiry)||JSON.stringify(event).includes(reply)), 'order identity and chat context remain inside encrypted rumors');
});


test('Buying listing inquiry uses the real card coordinate through NDR request and reply',{timeout:45000},async t=>{
 const bus=relay(),requester=app(bus),responder=app(bus),apps=[requester,responder];
 t.after(async()=>{for(const client of apps)await client.destroy();});
 for(const client of apps)await client.createAccount();await waitFor(()=>apps.every(client=>client.state().canSend));
 const requesterOwner=requester.state().ownerPubkey,responderOwner=responder.state().ownerPubkey;
 const buying={...listing,author:requesterOwner,id:`${requesterOwner}:need-city-cycle`,side:'request',title:'Buying a city bicycle'};
 const context=listingContext(buying.id);
 await responder.open(buying.author);await responder.send(buying.author,'Synthetic response to the Buying listing',context);
 await waitFor(()=>requester.state().conversations.some(chat=>chat.messages.some(message=>message.text==='Synthetic response to the Buying listing')));
 const incoming=requester.state().conversations.flatMap(chat=>chat.messages).find(message=>message.text==='Synthetic response to the Buying listing');
 assert.equal(incoming.context.listing,`30402:${buying.id}`);assert.deepEqual(incoming.context,context);assert.equal(incoming.orderId,undefined);
 await requester.send(responderOwner,'Synthetic Buying inquiry reply',incoming.context);
 await waitFor(()=>responder.state().conversations.some(chat=>chat.messages.some(message=>message.text==='Synthetic Buying inquiry reply')));
 const reply=responder.state().conversations.flatMap(chat=>chat.messages).find(message=>message.text==='Synthetic Buying inquiry reply');
 assert.deepEqual(reply.context,context);assert.equal(messageThreadKey(reply),`thread:${context.thread_id}`);
 assert(!bus.frames.some(event=>JSON.stringify(event).includes(context.thread_id)||JSON.stringify(event).includes(buying.id)), 'Buying context stays inside encrypted rumors');
});

async function privatePickup(){
 const a=await book(buyer),b=await book(seller),c=await book(courier);
 const source=await a.book.request(listing);await b.book.receive(rumorFor(a.book,'request'),buyer);
 await b.book.update(source.id,{status:'accepted'});await a.book.receive(rumorFor(b.book,'status'),seller);
 await b.book.update(source.id,{shipment:{stops:[{id:'pickup',label:'Shop',address:'Merchant shop',coordinates:[24,60]}]}});
 await a.book.receive(rumorFor(b.book,'route'),seller);return {a,b,c,id:source.id};
}
const transport={...listing,id:`${courier}:transport`,author:courier,title:'Transport'};
const destination={label:'Home',address:'Secret destination',coordinates:[25,61]};
test('separate delivery uses exact private peers, collection reference, and local-only order links',async()=>{
 const {a,b,c,id}=await privatePickup();const delivery=await a.book.requestDelivery(id,transport,destination);
 assert.equal(delivery.sourceOrderId,id);assert.equal(a.book.state().find(o=>o.id===id).deliveryOrderId,delivery.id);
 const auth=rumorFor(a.book,'pickup',seller),request=rumorFor(a.book,'request',courier);
 assert(!JSON.stringify(auth).includes(destination.address));assert(!JSON.stringify(request).includes(id));
 assert(!JSON.stringify(request).includes('sourceOrderId'));assert(!JSON.stringify(auth).includes('deliveryOrderId'));
 assert.deepEqual(a.book.jobs().filter(j=>j.orderId===id).map(j=>j.recipient),[seller,seller]);
 assert.deepEqual(a.book.jobs().filter(j=>j.orderId===delivery.id).map(j=>j.recipient),[courier]);
 await b.book.receive(auth,buyer);await c.book.receive(request,buyer);
 assert.equal(b.book.state()[0].pickupAuthorization.courierPubkey,courier);
 assert.equal(c.book.state()[0].deliveryRequest.collection.reference,b.book.state()[0].pickupAuthorization.reference);
 assert.equal(c.book.state()[0].sourceOrderId,undefined);assert.equal(b.book.state()[0].deliveryRequest,undefined);
 await assert.rejects(b.book.update(id,{pickupAuthorization:{courierPubkey:courier,reference:'bad'}}),/Only the buyer/);
 await assert.rejects(b.book.requestDelivery(id,transport,destination),/your accepted/);
 await assert.rejects(a.book.requestDelivery(id,transport,destination),/already/);
 await c.book.update(delivery.id,{status:'accepted'});
 const changed=eventFor(c.book,'status');changed.snapshot.deliveryRequest.destination.address='Tampered';
 const previous={order:delivery,clocks:{},archived:false};
 assert.throws(()=>applyOrderEnvelope(previous,changed,courier,buyer,1800000000),/changed the order/);
});
test('delivery request and pickup authorization fail atomically on persistence errors',async()=>{
 const {a,id}=await privatePickup();const before=a.book.state(),jobs=a.book.jobs();let writes=0;
 a.vault.put=async()=>{writes++;throw Error('full')};
 await assert.rejects(a.book.requestDelivery(id,transport,destination),/full/);
 assert.equal(writes,1);assert.deepEqual(a.book.state(),before);assert.deepEqual(a.book.jobs(),jobs);
});
test('standalone delivery requests are bounded and immutable on wire',async()=>{
 const a=await book(buyer);const delivery=await a.book.request(transport,{deliveryRequest:{pickup:{label:'Pickup',address:'Station'},destination}});
 assert.deepEqual(delivery.deliveryRequest.destination,destination);
 assert.throws(()=>a.book.request(transport,{deliveryRequest:{pickup:{label:'',address:'Station'},destination:{...destination,address:'x'.repeat(501)}}}),/Invalid address/);
 const draft=await a.book.request(listing);await assert.rejects(a.book.requestDelivery(draft.id,transport,destination),/accepted/);
});

test('payment terms belong to seller, validate mint and amount, and freeze after received',async()=>{
 const a=await book(buyer),b=await book(seller);const order=await a.book.request(listing);await b.book.receive(rumorFor(a.book,'request'),buyer);
 const term={mint:'https://mint.example/',amount:'00125',unit:'sat',status:'requested'};
 await assert.rejects(a.book.update(order.id,{payment:term}),/Only the seller/);
 await b.book.update(order.id,{payment:term});await a.book.receive(rumorFor(b.book,'payment'),seller);
 assert.deepEqual(a.book.state()[0].payment,{...term,mint:'https://mint.example',amount:'125'});
 for(const invalid of [{mint:'http://mint.example'},{mint:'https://mint.example/?key=secret'},{mint:'https://u:p@mint.example'},{amount:'0'},{amount:'1000000000001'},{amount:'1.5'}])assert.throws(()=>b.book.update(order.id,{payment:{...term,...invalid}}));
 await b.book.update(order.id,{payment:{...term,status:'received'}});await a.book.receive(rumorFor(b.book,'payment'),seller);
 assert.equal(a.book.state()[0].payment.status,'received');
 await assert.rejects(b.book.update(order.id,{payment:{...term,amount:'126',status:'received'}}),/cannot change/);
 const request=eventFor(a.book,'request');request.payload.payment=term;
 assert.throws(()=>applyOrderEnvelope(undefined,request,buyer,seller,1800000000),/Invalid order request/);
});

test('later seller snapshots recover skipped payment updates without allowing buyer forgery or received rollback',async()=>{
 const a=await book(buyer),b=await book(seller);const order=await a.book.request(listing);await b.book.receive(rumorFor(a.book,'request'),buyer);
 const term={mint:'https://mint.example',amount:'125',unit:'sat',status:'requested'};
 await b.book.update(order.id,{payment:term});const early=rumorFor(b.book,'payment');
 await b.book.update(order.id,{status:'accepted'});await a.book.receive(rumorFor(b.book,'status'),seller);
 assert.deepEqual(a.book.state()[0].payment,term);assert.equal(await a.book.receive(early,seller),null);
 await b.book.update(order.id,{payment:{...term,status:'received'}});
 await b.book.update(order.id,{status:'in-transit'});await a.book.receive(rumorFor(b.book,'status'),seller);
 assert.equal(a.book.state()[0].payment.status,'received');
 const current=a.book.state()[0],record={order:current,clocks:{},archived:false};
 const rollback={...eventFor(b.book,'status'),opId:crypto.randomUUID(),seq:100,snapshot:{...current,payment:{...term,amount:'999'}}};
 assert.equal(applyOrderEnvelope(record,rollback,seller,buyer,1800000000).record.order.payment.status,'received');
 const forged={...rollback,action:'status',payload:{status:'cancelled'},snapshot:{...current,payment:{...term,amount:'999',status:'received'}}};
 assert.equal(applyOrderEnvelope(record,forged,buyer,seller,1800000000).record.order.payment.amount,'125');
});
test('later buyer snapshots recover pickup authorization and seller snapshots cannot forge it',async()=>{
 const {a,b,id}=await privatePickup();
 const auth={courierPubkey:courier,reference:'collection-code'};
 await a.book.update(id,{pickupAuthorization:auth});const early=rumorFor(a.book,'pickup');
 await a.book.update(id,{status:'cancelled'});await b.book.receive(rumorFor(a.book,'status'),buyer);
 assert.deepEqual(b.book.state()[0].pickupAuthorization,auth);assert.equal(await b.book.receive(early,buyer),null);
 const {a:c,b:d,id:other}=await privatePickup();
 await d.book.update(other,{status:'in-transit'});const event=eventFor(d.book,'status');event.snapshot.pickupAuthorization=auth;
 const record={order:c.book.state()[0],clocks:{},archived:false};
 assert.equal(applyOrderEnvelope(record,event,seller,buyer,1800000000).record.order.pickupAuthorization,undefined);
});

test('local HTTP payment mint requires exact explicit loopback configuration on sender and recipient',async()=>{
 const developerMint='http://127.0.0.1:3338',a=await book(buyer,{developerMint}),b=await book(seller,{developerMint}),production=await book(buyer);
 const order=await a.book.request(listing);await b.book.receive(rumorFor(a.book,'request'),buyer);await production.book.receive(rumorFor(a.book,'request'),buyer);
 const term={mint:`${developerMint}/`,amount:'125',unit:'sat',status:'requested'};
 await b.book.update(order.id,{payment:term});const paymentRumor=rumorFor(b.book,'payment');
 assert(await a.book.receive(paymentRumor,seller));assert.equal(a.book.state()[0].payment.mint,developerMint);
 assert.equal(await production.book.receive(paymentRumor,seller),null);assert.equal(production.book.state()[0].payment,undefined);
 for(const mint of ['http://127.0.0.1:3339','http://localhost:3338','http://example.com:3338','http://127.0.0.1:3338/path','http://127.0.0.1:3338/?secret=x'])assert.throws(()=>b.book.update(order.id,{payment:{...term,mint}}),/secure mint/);
 await b.book.update(order.id,{status:'accepted'});await a.book.receive(rumorFor(b.book,'status'),seller);assert.equal(a.book.state()[0].payment.mint,developerMint);
 const snapshotEvent=eventFor(b.book,'status');const prior={order:order,clocks:{},archived:false};
 assert.throws(()=>applyOrderEnvelope(prior,snapshotEvent,seller,buyer,1800000000),/secure mint/);
 assert.equal(applyOrderEnvelope(prior,snapshotEvent,seller,buyer,1800000000,device,{developerMint}).record.order.payment.mint,developerMint);
 assert.throws(()=>createOrderBook({vault:a.vault,owner:buyer,device,developerMint:'http://example.com:3338'}),/Local test mint/);
});
