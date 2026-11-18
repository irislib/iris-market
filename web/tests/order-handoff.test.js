import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools';
import {createOrderBook,decodeOrder,applyOrderEnvelope} from '../src/orders.ts';
import {createRecipientKey,verifyHandoff} from '../src/order-handoff.ts';
import {createVault} from '../src/messaging/vault.ts';

const vector=JSON.parse(await readFile(new URL('../../shared/handoff-vector.json',import.meta.url)));
const keys=secret=>({deviceSecret:()=>secret,accountSigner:()=>undefined});
test('shared native vector derives the same per-order key and checks only a canonical, fresh signature',()=>{
  assert.deepEqual(createRecipientKey(keys(new Uint8Array(32).fill(7)),vector.id),{id:vector.id,key:vector.key});
  const expected={...vector,action:'scan'};
  for(const offset of [-15,0,120])verifyHandoff(expected,vector.pass,vector.createdAt+offset);
  for(const offset of [-16,121])assert.throws(()=>verifyHandoff(expected,vector.pass,vector.createdAt+offset),/fresh/);
  for(const qr of [vector.pass+'\n',vector.pass+':extra',vector.pass.toUpperCase(),vector.pass.replace(':1700000000:',':01700000000:'),vector.pass.slice(0,-1)+'0','https://example.com/'])
    assert.throws(()=>verifyHandoff(expected,qr,vector.createdAt));
  for(const different of [{kind:'dropoff'},{id:crypto.randomUUID()},{key:getPublicKey(generateSecretKey())}])
    assert.throws(()=>verifyHandoff({...expected,...different},vector.pass,vector.createdAt));
});

const time=1700000000;
function actor(){
  const secret=generateSecretKey(),device=generateSecretKey(),owner=getPublicKey(secret);
  const identity={deviceSecret:()=>device,accountSigner:()=>draft=>finalizeEvent(draft,secret)};
  return {owner,identity};
}
async function open(person,vault){
  if(!vault){
    let row;
    const backend={read:async()=>structuredClone(row),write:async(value,version)=>{assert.equal(row?.version??0,version);row=structuredClone(value)}};
    vault=createVault({backend});await vault.create();
  }
  const book=createOrderBook({vault,owner:person.owner,device:getPublicKey(person.identity.deviceSecret()),handoffKeys:person.identity,now:()=>time});
  await book.load();
  return {...person,book,vault};
}
const product=seller=>({side:'offer',author:seller.owner,id:seller.owner+':mug',title:'Mug',price:12,currency:'EUR'});
const jobs=(from,to,action)=>from.book.jobs().findLast(job=>job.recipient===to.owner && job.action===action);
const deliver=(from,to,action)=>to.book.receive(jobs(from,to,action).rumor,from.owner,getPublicKey(from.identity.deviceSecret()));
const actions=(person,id)=>person.book.state().find(item=>item.id===id).handoffs;
const pickup={label:'Shop',address:'Shop counter'},destination={label:'Destination',address:'Agreed delivery place'};
async function accepted(fulfillment){
  const a=await open(actor()),b=await open(actor()),item=product(b),order=await a.book.request(item,{fulfillment});
  await deliver(a,b,'request');await b.book.update(order.id,{status:'accepted'});await deliver(b,a,'status');
  return {a,b,item,order};
}

test('self-pickup availability, legacy echoes, sibling device, replay across orders and encrypted restart',async()=>{
  const {a,b,item,order}=await accepted('pickup'),id=order.id;
  assert.deepEqual(actions(a,id),[{kind:'pickup',action:'show'}]);
  assert.deepEqual(actions(b,id),[{kind:'pickup',action:'scan'}]);
  const sibling=await open({...a,identity:keys(generateSecretKey())},a.vault);
  assert.deepEqual(actions(sibling,id),[]);await assert.rejects(sibling.book.showHandoff(id,'pickup'),/device used at checkout/);
  const qr=await a.book.showHandoff(id,'pickup'),queue=b.book.jobs().length;
  await assert.rejects(b.book.checkHandoff(id,'dropoff',qr),/unavailable/);
  await assert.rejects(a.book.checkHandoff(id,'pickup',qr),/unavailable/);
  const echo=decodeOrder(jobs(b,a,'status').rumor);
  const record={order:a.book.state()[0],clocks:{},archived:false};
  for(const bad of [{...order.recipientHandoff,key:b.owner},{...order.recipientHandoff,key:a.owner},
    {...order.recipientHandoff,key:'f'.repeat(64)},{...order.recipientHandoff,extra:true}]){
    echo.snapshot.recipientHandoff=bad;
    assert.throws(()=>applyOrderEnvelope(record,echo,b.owner,a.owner,time),/handoff key/);
  }
  delete echo.snapshot.recipientHandoff;
  assert.deepEqual(applyOrderEnvelope(record,echo,b.owner,a.owner,time).record.order.recipientHandoff,order.recipientHandoff);
  echo.snapshot.recipientHandoff={...order.recipientHandoff,id:crypto.randomUUID()};
  assert.throws(()=>applyOrderEnvelope(record,echo,b.owner,a.owner,time),/changed the order/);
  delete record.order.recipientHandoff;
  assert.throws(()=>applyOrderEnvelope(record,echo,b.owner,a.owner,time),/changed the order/);
  const save=b.vault.put;
  b.vault.put=async()=>{throw Error('No storage space')};
  await assert.rejects(b.book.checkHandoff(id,'pickup',qr),/storage space/);
  assert.deepEqual(actions(b,id),[{kind:'pickup',action:'scan'}]);b.vault.put=save;
  const checked=await Promise.allSettled([b.book.checkHandoff(id,'pickup',qr),b.book.checkHandoff(id,'pickup',qr)]);
  assert.deepEqual(checked.map(result=>result.status).sort(),['fulfilled','rejected']);
  assert.equal(b.book.jobs().length,queue);assert.equal(b.book.state()[0].status,'accepted');assert.equal(b.book.state()[0].payment,undefined);
  assert.deepEqual(actions(b,id),[{kind:'pickup',action:'checked'}]);assert(!JSON.stringify(await b.vault.get('market/orders/v1')).includes(qr));
  const restarted=await open(b,b.vault);
  await assert.rejects(restarted.book.checkHandoff(id,'pickup',qr),/already checked/);
  const second=await a.book.request(item,{fulfillment:'pickup'});const rumor=structuredClone(jobs(a,restarted,'request').rumor);
  const tag=rumor.tags.find(t=>t[0]==='iris-market-order'),event=JSON.parse(tag[2]);event.payload.recipientHandoff=event.snapshot.recipientHandoff=order.recipientHandoff;
  tag[2]=JSON.stringify(event);await restarted.book.receive(rumor,a.owner,getPublicKey(a.identity.deviceSecret()));
  await restarted.book.update(second.id,{status:'accepted'});await assert.rejects(restarted.book.checkHandoff(second.id,'pickup',qr),/already checked/);
  assert.deepEqual(actions(restarted,second.id),[]);
  await restarted.book.update(id,{status:'delivered'});assert.deepEqual(actions(restarted,id),[{kind:'pickup',action:'checked'}]);
  await assert.rejects(restarted.book.checkHandoff(id,'pickup',qr),/unavailable/);
});

test('separate delivery shares the scoped destination key, authenticates the courier at pickup and never shares a source order',async()=>{
  for(const method of ['merchant-delivery','buyer-courier']){
    const {a,b,order}=await accepted(method),c=await open(actor());
    const organizer=method==='merchant-delivery'?b:a;
    const service={...product(c),category:'transport',tags:['parcel'],title:'Parcel delivery',id:c.owner+':parcels'};
    if(organizer===a){await b.book.update(order.id,{shipment:{stops:[{id:'store',...pickup,status:'pending'}]}});await deliver(b,a,'route')}
    const separate=await organizer.book.requestDelivery(order.id,service,destination,organizer===b?pickup:undefined);
    assert.deepEqual(separate.recipientHandoff,order.recipientHandoff);
    const rumor=jobs(organizer,c,'request').rumor;
    for(const privateItem of [order.id,'Mug',...(organizer===b?[a.owner]:[])])assert(!JSON.stringify(rumor).includes(privateItem));
    await deliver(organizer,c,'request');await deliver(organizer,organizer===a?b:a,'pickup');
    assert.deepEqual(actions(c,separate.id),[]);await c.book.update(separate.id,{status:'accepted'});
    const missingSigner=await open({...c,identity:{...c.identity,accountSigner:()=>undefined}},c.vault);
    assert.deepEqual(actions(missingSigner,separate.id),[{kind:'dropoff',action:'scan'}]);
    await assert.rejects(missingSigner.book.showHandoff(separate.id,'pickup'),/signer/);
    const collection=await c.book.showHandoff(separate.id,'pickup');
    assert.deepEqual(actions(b,order.id),[{kind:'pickup',action:'scan'}]);
    await b.book.checkHandoff(order.id,'pickup',collection);
    const destinationQr=await a.book.showHandoff(order.id,'dropoff');
    await assert.rejects(b.book.checkHandoff(order.id,'dropoff',destinationQr),/unavailable/);
    await c.book.checkHandoff(separate.id,'dropoff',destinationQr);
    const replace=crypto.randomUUID();
    await organizer.book.update(order.id,{pickupAuthorization:{courierPubkey:c.owner,reference:replace}});
    if(organizer!==b)await deliver(organizer,b,'pickup');
    assert.deepEqual(actions(b,order.id),[{kind:'pickup',action:'scan'}]);
    await assert.rejects(b.book.checkHandoff(order.id,'pickup',collection),/does not match/);
  }
});

test('own delivery and route-only privacy keep distinct scanners; escrow retries preserve the first pass',async()=>{
  const {a,b,order,item}=await accepted('merchant-delivery'),courier=await open(actor());
  const qr=await a.book.showHandoff(order.id,'dropoff');
  assert.deepEqual(actions(b,order.id),[{kind:'dropoff',action:'scan'}]);
  await b.book.update(order.id,{shipment:{stops:[{id:'here',...pickup,status:'pending',courierPubkey:courier.owner}]}});
  const route=jobs(b,courier,'route').rumor;
  assert(!JSON.stringify(route.tags).includes(order.recipientHandoff.key));assert(!JSON.stringify(route.tags).includes(order.recipientHandoff.id));
  await deliver(b,courier,'route');assert.deepEqual(actions(courier,order.id),[]);
  await assert.rejects(b.book.checkHandoff(order.id,'dropoff',qr),/unavailable/);
  await b.book.update(order.id,{shipment:{stops:[],trackingUrl:'https://example.org/tracking'}});
  assert.deepEqual(actions(b,order.id),[]);
  await b.book.update(order.id,{shipment:{stops:[]}});await b.book.checkHandoff(order.id,'dropoff',qr);
  const selection={fulfillment:'pickup',escrowTradeId:'a'.repeat(64),escrowProvider:courier.owner},listing={...item,escrow:{trade:'goods'}};
  const first=await a.book.request(listing,selection),again=await a.book.request(listing,selection);
  assert.equal(again.id,first.id);assert.deepEqual(again.recipientHandoff,first.recipientHandoff);
  const legacy=await a.book.request(item);
  assert.equal(legacy.recipientHandoff,undefined);assert.deepEqual(legacy.handoffs,[]);
});
