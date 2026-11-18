// Run from the repository root after installing the locked web dependencies.
// Synthetic memory relay only; no network, live profile, mint, or payment.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createMessaging} from '../../../web/src/messaging/client.ts';
import {createVault} from '../../../web/src/messaging/vault.ts';
const require=createRequire(new URL('../../../web/package.json',import.meta.url));
const {generateSecretKey,getPublicKey,matchFilters,verifyEvent}=require('nostr-tools');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const dir=await mkdtemp(join(tmpdir(),'market-order-interop-'));
const events=new Map(),subscriptions=new Set(),frames=[];
const publish=async event=>{assert(verifyEvent(structuredClone(event)));events.set(event.id,event);frames.push(event);for(const sub of subscriptions)if(matchFilters(sub.filters,event))queueMicrotask(()=>sub.onEvent(event));return {remoteAccepted:true};};
const factory=()=>{const own=new Set();return {
  subscribe(filters,{onEvent}){const sub={filters,onEvent};own.add(sub);subscriptions.add(sub);queueMicrotask(()=>{for(const event of events.values())if(matchFilters(filters,event))onEvent(event);});return {close(){own.delete(sub);subscriptions.delete(sub);}};},
  async query(filters){return {events:[...events.values()].filter(e=>matchFilters(filters,e)),complete:true,sources:[]};},publish,
  close(){for(const sub of own)subscriptions.delete(sub);own.clear();}
};};
function newPeer(){
  let row;
  const vault=createVault({backend:{read:async()=>structuredClone(row),write:async(value,expected)=>{
    if(expected!==undefined&&(row?.version??0)!==expected)throw Error('vault conflict');
    row=structuredClone(value);
  }}});
  return createMessaging({vault,getRelays:()=>['wss://test.invalid'],transportFactory:factory});
}
const app=newPeer();
let carrier;
const waitFor=async predicate=>{const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw Error('Interop condition timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
function contact(peer){
  const authorization=[...events.values()].filter(e=>e.kind===37368&&e.pubkey===peer.state().ownerPubkey).at(-1);
  const invite=[...events.values()].filter(e=>e.kind===30078&&e.pubkey===peer.state().devicePubkey).at(-1);
  return {authorization,invite};
}
async function native(extra={}) {
  const {authorization,invite}=contact(app);
  assert(authorization&&invite);
  const input=join(dir,'input.json'),output=join(dir,'output.json');
  await writeFile(input,JSON.stringify({authorization,invite,...extra}));
  const result=spawnSync('cargo',['test','--locked','-p','iris-market-core','--test','js_interop','javascript_runtime_wire_roundtrip','--','--ignored','--exact'],{cwd:root,encoding:'utf8',env:{...process.env,RUSTC_WRAPPER:'',CARGO_BUILD_JOBS:'2',MARKET_INTEROP_JS_INPUT:input,MARKET_INTEROP_RUST_OUTPUT:output,MARKET_INTEROP_DATA_DIR:join(dir,'native')}});
  assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);
  const value=JSON.parse(await readFile(output,'utf8'));
  await publish(value.authorization);await publish(value.invite);
  for(const event of value.outgoing)await publish(event);
  return value;
}
try {
  await app.createAccount();await waitFor(()=>app.state().canSend&&[...events.values()].some(e=>e.kind===30078));
  const initial=await native({send_text:'Hello from native'});
  await waitFor(()=>app.state().conversations.some(c=>c.messages.some(m=>m.text==='Hello from native')));
  const before=frames.length;
  const order=await app.requestOrder({id:`${initial.owner_public_key}:synthetic-delivery`,author:initial.owner_public_key,title:'Cross-platform delivery',price:'12',currency:'EUR',side:'offer'},{quantity:2,note:'Synthetic private note',fulfillment:'merchant-delivery'});
  await waitFor(()=>app.state().orders.find(o=>o.id===order.id)?.sync==='sent');
  const incoming=frames.slice(before).filter(e=>[1059,1060].includes(e.kind));
  const accepted=await native({incoming,expected_order:order.id,order_patch:{status:'accepted'}});
  assert.equal(accepted.orders[0].items[0].quantity,2);
  assert.equal(accepted.orders[0].fulfillment,'merchant-delivery');
  const courier=getPublicKey(generateSecretKey()),pickupAuthorization={courierPubkey:courier,reference:'Synthetic collection'};
  await native({expected_order:order.id,order_patch:{pickupAuthorization}});
  await waitFor(()=>app.state().orders.find(o=>o.id===order.id)?.pickupAuthorization?.courierPubkey===courier);
  await waitFor(()=>app.state().orders.find(o=>o.id===order.id)?.status==='accepted');
  const routed=await native({expected_order:order.id,order_patch:{shipment:{stops:[{id:'pickup',label:'Pickup',address:'Private synthetic address',coordinates:[24.94,60.17]}],trackingUrl:'https://tracking.example/test'}}});
  await waitFor(()=>app.state().orders.find(o=>o.id===order.id)?.shipment.stops.length===1);
  assert.equal(app.state().orders[0].shipment.stops[0].address,'Private synthetic address');
  assert(routed.outgoing.every(e=>!JSON.stringify(e).includes('Private synthetic address')));
  const provider=getPublicKey(generateSecretKey()),tradeId='5'.repeat(64);
  const listing={id:`${initial.owner_public_key}:protected`,author:initial.owner_public_key,title:'Escrow pickup',price:'12',currency:'SATS',side:'offer',escrow:{trade:'goods'}};
  const selection={escrowTradeId:tradeId,escrowProvider:provider,fulfillment:'pickup'};
  await assert.rejects(app.requestOrder(listing,selection),/Enable escrow/);
  // This standalone memory harness has no browser settings storage.
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>key===`market-tools-v1/${app.state().ownerPubkey}/escrow`?'1':null}});
  const start=frames.length,linked=await app.requestOrder(listing,selection);
  await waitFor(()=>app.state().orders.find(o=>o.id===linked.id)?.sync==='sent');
  const next=await native({incoming:frames.slice(start).filter(e=>[1059,1060].includes(e.kind)),expected_order:linked.id,order_patch:{status:'accepted'}});
  const received=next.orders.find(o=>o.id===linked.id);
  await waitFor(()=>app.state().orders.find(o=>o.id===linked.id)?.status==='accepted');
  const pass=await app.showOrderHandoff(linked.id,'pickup');
  const nativeCheck=await native({expected_order:linked.id,pickup_pass:pass});
  const checked=nativeCheck.orders.find(o=>o.id===linked.id);
  assert.deepEqual(checked.handoffs,[{kind:'pickup',action:'checked'}]);
  assert.equal(checked.status,'accepted');
  assert.ok(!JSON.stringify(nativeCheck).includes(pass));
  assert(!checked.pickupReceipt,'An authority check cannot issue a receipt');

  // No messages are delivered to Rust between these calls. The merchant receives
  // the collector signature by scan and reopens its own private storage to confirm.
  const acknowledgment=await app.acknowledgeOrderPickup(linked.id);
  const pending=await native({expected_order:linked.id,pickup_pass:acknowledgment});
  assert.equal(pending.orders.find(o=>o.id===linked.id).pickupReceipt.state,'awaiting-confirmation');
  assert.equal(app.state().orders.find(o=>o.id===linked.id).pickupReceipt.state,'acknowledged');
  const merchant=await native({expected_order:linked.id,confirm_pickup:true});
  const merchantView=merchant.orders.find(o=>o.id===linked.id);
  assert.equal(merchantView.pickupReceipt.state,'confirmed');
  await waitFor(()=>app.state().orders.find(o=>o.id===linked.id)?.pickupReceipt?.state==='confirmed');
  const buyer=app.state().orders.find(o=>o.id===linked.id);
  assert.equal(buyer.pickupReceipt.confirmedAt,merchantView.pickupReceipt.confirmedAt);
  assert.equal(buyer.status,'accepted');
  assert.equal(buyer.escrowTradeId,tradeId);
  assert(!buyer.payment);
  for(const data of [frames,app.state().conversations,merchant.conversations]){
    assert(!JSON.stringify(data).includes(acknowledgment.split(':').at(-1)));
  }

  assert.equal(received.fulfillment,'pickup');assert.equal(received.escrowProvider,provider);assert.equal(received.escrowTradeId,tradeId);
  await waitFor(()=>app.state().orders.find(o=>o.id===linked.id)?.status==='accepted');
  assert(frames.slice(start).every(e=>!JSON.stringify(e).includes(provider)&&!JSON.stringify(e).includes(tradeId)));
  console.log('PASS: direct and escrow JS requests → Rust accept → JS projection; authenticated NDR, no public provider or trade ID');

  // Three distinct accounts. The delivery customer appoints a courier; the
  // merchant can return the signed receipt without joining their delivery job.
  carrier=newPeer();await carrier.createAccount();
  await waitFor(()=>contact(carrier).invite&&contact(carrier).authorization);
  await native({additional_contact:contact(carrier)});
  const packetsFrom=start=>frames.slice(start).filter(e=>[1059,1060].includes(e.kind));
  const beforeGoods=frames.length;
  const goods=await app.requestOrder({...listing,escrow:undefined,title:'Private parcel'},{fulfillment:'buyer-courier'});
  await waitFor(()=>app.state().orders.find(o=>o.id===goods.id)?.sync==='sent');
  await native({incoming:packetsFrom(beforeGoods),subscribed_only:true,expected_order:goods.id,order_patch:{status:'accepted'}});
  await waitFor(()=>app.state().orders.find(o=>o.id===goods.id)?.status==='accepted');
  await native({expected_order:goods.id,order_patch:{shipment:{stops:[{id:'shop',label:'Collection',address:'Synthetic shop'}]}}});
  await waitFor(()=>app.state().orders.find(o=>o.id===goods.id)?.shipment.stops.length===1);
  const beforeBooking=frames.length;
  const courierKey=carrier.state().ownerPubkey;
  const job=await app.requestDelivery(goods.id,{id:`${courierKey}:parcel`,author:courierKey,side:'offer',tags:['parcel'],title:'Parcel delivery',price:'1',currency:'EUR'},
    {label:'Door',address:'Synthetic buyer destination'});
  const carrierView=()=>carrier.state().orders.find(o=>o.id===job.id);
  await waitFor(()=>carrierView()&&app.state().orders.find(o=>o.id===goods.id)?.sync==='sent');
  await carrier.updateOrder(job.id,{status:'accepted'});
  const booked=await native({subscribed_only:true,incoming:packetsFrom(beforeBooking),expected_order:goods.id});
  assert.equal(booked.orders.find(o=>o.id===goods.id).pickupAuthorization.courierPubkey,courierKey);
  assert(!JSON.stringify(booked).includes('Synthetic buyer destination'));
  const collectorPass=await carrier.acknowledgeOrderPickup(job.id);
  // Scan once. Both remote recipients get their own independently verified copies.
  const complete=await native({expected_order:goods.id,pickup_pass:collectorPass,confirm_pickup:true});
  const merchantReceipt=complete.orders.find(o=>o.id===goods.id).pickupReceipt;
  assert.equal(merchantReceipt.state,'confirmed');
  await waitFor(()=>[carrierView(),app.state().orders.find(o=>o.id===goods.id)].every(o=>o?.pickupReceipt?.state==='confirmed'));
  assert.equal(carrierView().pickupReceipt.confirmedAt,merchantReceipt.confirmedAt);
  assert.equal(carrierView().status,'accepted');
  assert(!JSON.stringify(carrier.state().orders).includes(goods.id));
  assert(!JSON.stringify(carrier.state().conversations).includes('Private parcel'));
  assert(!JSON.stringify(frames).includes(collectorPass.split(':').at(-1)));
  console.log('PASS: JS buyer-authorized courier → Rust merchant → private receipts on both distinct JS orders');
} finally { await carrier?.destroy();await app.destroy();await rm(dir,{recursive:true,force:true}); }
