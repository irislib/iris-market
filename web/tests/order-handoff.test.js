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
async function open(person,vault,now=()=>time){
  if(!vault){
    let row;
    const backend={read:async()=>structuredClone(row),write:async(value,version)=>{assert.equal(row?.version??0,version);row=structuredClone(value)}};
    vault=createVault({backend});await vault.create();
  }
  const book=createOrderBook({vault,owner:person.owner,device:getPublicKey(person.identity.deviceSecret()),handoffKeys:person.identity,now});
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

const view=(person,id)=>person.book.state().find(order=>order.id===id);
const sendPickup=(from,to,action)=>to.book.receivePickup(jobs(from,to,action).rumor,from.owner);

test('shared pickup signatures verify as two separate statements and use only canonical QR/tag encodings',async()=>{
  const {parsePickupQR,receiptQR,pickupTag,readPickupTag,verifyPickup}=await import('../src/pickup-receipt.ts');
  const v=JSON.parse(await readFile(new URL('../../shared/pickup-receipt-vector.json',import.meta.url)));
  const ctx={ref:v.ref,key:v.collectorKey,collector:v.collectorKey,merchant:v.merchant};
  const ack=parsePickupQR(v.ackQr,false),receipt=parsePickupQR(v.receiptQr,true);
  assert.deepEqual(pickupTag(ack),v.ackTag);assert.deepEqual(pickupTag(receipt),v.receiptTag);
  assert.equal(receiptQR(ack),v.ackQr);assert.equal(receiptQR(receipt),v.receiptQr);
  assert.equal(verifyPickup(ctx,ack,v.collectedAt+120),v.collectorEventId);
  assert.equal(verifyPickup(ctx,receipt,v.confirmedAt+86400),v.collectorEventId);
  assert.throws(()=>verifyPickup(ctx,ack,v.collectedAt+121));
  assert.throws(()=>verifyPickup({...ctx,merchant:v.collectorKey},receipt,v.confirmedAt));
  assert.throws(()=>verifyPickup(ctx,{...receipt,merchantSig:ack.collectorSig},v.confirmedAt));
  for(const qr of [v.receiptQr+':extra',v.receiptQr.replace(v.ref,v.ref.toUpperCase()),v.receiptQr.replace(String(v.collectedAt),'0'+v.collectedAt),'https://site.test',v.ackQr])assert.throws(()=>parsePickupQR(qr,true));
  assert.throws(()=>readPickupTag([...v.ackTag,'extra']));
});

test('self pickup accepts a private acknowledgment without camera, confirms once, and survives mixed legacy and offline receipt import',async()=>{
  const {a,b,order}=await accepted('pickup'),id=order.id;
  assert.equal(view(a,id).pickupReceiptRole,'collector');assert.equal(view(b,id).pickupReceiptRole,'merchant');
  await b.book.checkHandoff(id,'pickup',await a.book.showHandoff(id,'pickup'));
  assert.equal(view(b,id).pickupReceipt,undefined);await assert.rejects(b.book.confirmOrderPickup(id));
  const qr=await a.book.acknowledgeOrderPickup(id);assert.equal(qr,await a.book.acknowledgeOrderPickup(id));
  assert.equal(view(a,id).pickupReceipt.state,'acknowledged');
  const ack=jobs(a,b,'pickup-ack').rumor;assert.equal(ack.content,'');assert.equal(ack.tags.find(t=>t[0]==='expiration')[1],String(time+121));
  assert(!JSON.stringify(ack).includes(id));assert(!JSON.stringify(ack).includes(a.owner));
  await b.book.receivePickup(ack,actor().owner);assert.equal(view(b,id).pickupReceipt,undefined);
  await sendPickup(a,b,'pickup-ack');assert.equal(view(b,id).pickupReceipt.state,'awaiting-confirmation');
  await b.book.checkHandoff(id,'pickup',qr);assert.equal(view(b,id).pickupReceipt.state,'awaiting-confirmation');
  await b.book.confirmOrderPickup(id);await b.book.confirmOrderPickup(id);
  const full=await b.book.showPickupReceipt(id);assert(full.startsWith('iris-pickup-receipt:1:'));assert.equal(b.book.jobs().filter(j=>j.action==='pickup-receipt').length,1);
  assert.equal(view(a,id).pickupReceipt.state,'acknowledged');
  await assert.rejects(a.book.verifyPickupReceipt(id,qr));await a.book.verifyPickupReceipt(id,full);
  assert.equal(view(a,id).pickupReceipt.state,'confirmed');await sendPickup(b,a,'pickup-receipt');assert.equal(await a.book.showPickupReceipt(id),full);
  const again=await open(a,a.vault);assert.equal(await again.book.showPickupReceipt(id),full);
  assert.equal(view(again,id).status,'accepted');assert.equal(view(again,id).payment,undefined);
});

test('independent courier and buyer obtain a private receipt for both booking arrangements, including reordered delivery',async()=>{
  for(const mode of ['buyer-courier','merchant-delivery']){
    const {a,b,order}=await accepted(mode),c=await open(actor()),organizer=mode==='buyer-courier'?a:b,id=order.id;
    const service={...product(c),title:'Parcel',category:'transport',tags:['parcel']};
    if(organizer===a){await b.book.update(id,{shipment:{stops:[{id:'store',...pickup,status:'pending'}]}});await deliver(b,a,'route')}
    const separate=await organizer.book.requestDelivery(id,service,destination,organizer===b?pickup:undefined);
    await deliver(organizer,c,'request');await c.book.update(separate.id,{status:'accepted'});
    if(organizer===a)await deliver(a,b,'pickup');
    const intent=await c.book.acknowledgeOrderPickup(separate.id);
    assert.equal(jobs(c,b,'pickup-ack').recipient,b.owner);assert(!jobs(c,a,'pickup-ack'));
    await b.book.checkHandoff(id,'pickup',intent);await b.book.confirmOrderPickup(id);
    const packet=jobs(b,c,'pickup-receipt').rumor,encoded=JSON.stringify(packet);
    assert.equal(packet.content,'');for(const privateField of [a.owner,id,separate.id,'Mug',pickup.address,destination.address,'EUR'])assert(!encoded.includes(privateField),privateField);
    await sendPickup(b,c,'pickup-receipt');
    assert.equal(view(c,separate.id).pickupReceipt.state,'confirmed');
    await sendPickup(b,a,'pickup-receipt');
    if(organizer===b){assert.equal(view(a,id).pickupReceipt,undefined);await deliver(b,a,'pickup')}
    assert.equal(view(a,id).pickupReceipt.state,'confirmed');assert.equal(view(a,id).pickupReceiptRole,'observer');
    const proof=await a.book.showPickupReceipt(id);
    assert.equal(await c.book.showPickupReceipt(separate.id),proof);
    const oldRef=view(b,id).pickupAuthorization.reference;
    const replacement={courierPubkey:c.owner,reference:crypto.randomUUID()};await organizer.book.update(id,{pickupAuthorization:replacement});
    const other=organizer===a?b:a;await deliver(organizer,other,'pickup');
    assert.equal(view(b,id).pickupReceipt,undefined);assert.equal(view(a,id).previousPickupReceipts[0].reference,oldRef);
    assert.equal(await a.book.showPickupReceipt(id,oldRef),proof);assert.throws(()=>a.book.showPickupReceipt(id));await a.book.verifyPickupReceipt(id,proof);
    await assert.rejects(b.book.checkHandoff(id,'pickup',intent));assert.equal(view(a,id).status,'accepted');
  }
});

test('freshness gates actual handover, expired partial jobs disappear, and valid final proofs outlive transit',async()=>{
  const {a,b,order}=await accepted('pickup'),id=order.id;let clock=time;
  const buyer=await open(a,a.vault,()=>clock),merchant=await open(b,b.vault,()=>clock);
  const first=await buyer.book.acknowledgeOrderPickup(id);
  await merchant.book.checkHandoff(id,'pickup',first);
  clock+=121;
  assert(!jobs(buyer,merchant,'pickup-ack'));await buyer.book.prune();
  await assert.rejects(merchant.book.confirmOrderPickup(id),/again/);
  const fresh=await buyer.book.acknowledgeOrderPickup(id);assert.notEqual(first,fresh);
  await sendPickup(buyer,merchant,'pickup-ack');await merchant.book.confirmOrderPickup(id);
  const proof=await merchant.book.showPickupReceipt(id);await merchant.book.update(id,{status:'delivered'});await deliver(merchant,buyer,'status');
  clock+=86400;await buyer.book.verifyPickupReceipt(id,proof);
  assert.equal(view(buyer,id).pickupReceipt.confirmedAt,time+121);
  assert.equal(view(buyer,id).status,'delivered');assert(!view(buyer,id).payment);
});

test('an external signer may decline without saving or sending a partial or complete receipt',async()=>{
  const {a,b,order}=await accepted('pickup'),id=order.id;
  const noMerchant=await open({...b,identity:{...b.identity,accountSigner:()=>undefined}},b.vault);
  await a.book.acknowledgeOrderPickup(id);await sendPickup(a,noMerchant,'pickup-ack');
  await assert.rejects(noMerchant.book.confirmOrderPickup(id),/signer/);
  assert.equal(view(noMerchant,id).pickupReceipt.state,'awaiting-confirmation');assert(!jobs(noMerchant,a,'pickup-receipt'));
  const sibling=await open({...a,identity:{...a.identity,deviceSecret:()=>new Uint8Array(32).fill(13)}},a.vault);
  // A fresh acknowledgment must come from the original checkout device.
  const fresh=await open(sibling,a.vault,()=>time+121);
  await assert.rejects(fresh.book.acknowledgeOrderPickup(id),/device/);
});

test('completed receipts with both signatures cannot be imported into another order or accepted from an unrelated sender',async()=>{
  const {a,b,order,item}=await accepted('pickup'),id=order.id;
  await a.book.acknowledgeOrderPickup(id);await sendPickup(a,b,'pickup-ack');await b.book.confirmOrderPickup(id);
  const completion=jobs(b,a,'pickup-receipt').rumor,proof=await b.book.showPickupReceipt(id);
  await a.book.receivePickup(completion,actor().owner);assert.equal(view(a,id).pickupReceipt.state,'acknowledged');
  const wrongPeer=structuredClone(completion);wrongPeer.tags[0][1]=actor().owner;
  await a.book.receivePickup(wrongPeer,b.owner);assert.equal(view(a,id).pickupReceipt.state,'acknowledged');
  const other=await a.book.request(item,{fulfillment:'pickup'});await deliver(a,b,'request');await b.book.update(other.id,{status:'accepted'});await deliver(b,a,'status');
  await assert.rejects(a.book.verifyPickupReceipt(other.id,proof),/does not match/);
  await assert.rejects(b.book.verifyPickupReceipt(id,proof),/does not match/);
});

test('receipt delivery can precede acceptance, while a signature dated after a terminal order cannot revive it',async()=>{
  const {a,b,order,item}=await accepted('pickup');
  const second=await a.book.request(item,{fulfillment:'pickup'});await deliver(a,b,'request');
  const {signCollection,signRelease,receiptQR}=await import('../src/pickup-receipt.ts');
  await b.book.update(second.id,{status:'accepted'});
  // The collector can use another signed-in device which already received acceptance.
  const secondScope={ref:second.recipientHandoff.id,key:second.recipientHandoff.key,merchant:b.owner,collector:a.owner};
  const signed=await signCollection(secondScope,time,a.identity);
  await b.book.checkHandoff(second.id,'pickup',receiptQR(signed));await b.book.confirmOrderPickup(second.id);
  await sendPickup(b,a,'pickup-receipt');assert.equal(view(a,second.id).pickupReceipt,undefined);
  await deliver(b,a,'status');assert.equal(view(a,second.id).pickupReceipt.state,'confirmed');
  await b.book.update(order.id,{status:'delivered'});await deliver(b,a,'status');
  const c={ref:order.recipientHandoff.id,key:order.recipientHandoff.key,merchant:b.owner,collector:a.owner};
  const lateAck=await signCollection(c,time+60,a.identity),late=await signRelease(c,lateAck,time+61,b.identity);
  const observer=await open(a,a.vault,()=>time+65);await assert.rejects(observer.book.verifyPickupReceipt(order.id,receiptQR(late)),/does not match/);
  assert.equal(view(observer,order.id).pickupReceipt,undefined);
});
