import test from 'node:test';
import assert from 'node:assert/strict';
import {startDemoRelay} from '../scripts/demo/relay.ts';
import {startDemoActors} from '../scripts/demo/actors.ts';
import {createMessaging} from '../src/messaging/client.ts';
import {createVault} from '../src/messaging/vault.ts';
import {orderContext} from '../src/message-context.ts';
import {parseEvent} from '../src/market.ts';

async function until(check,timeout=30000) {
  const start=Date.now();while(Date.now()-start<timeout){const result=check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error('Timed out waiting for private demo state');
}
test('real private order roundtrip: drone, ride, chat, tracking and cancellation',{timeout:60000},async()=>{
  const relay=await startDemoRelay(0);let bots,buyer,row;
  try {
    bots=await startDemoActors({relay:relay.url,origin:'http://127.0.0.1:4191',durationMs:12000,tickMs:100});
    for(const listing of bots.listings)assert.equal(parseEvent(listing.event).title,listing.title);
    buyer=createMessaging({getRelays:()=>[relay.url],vault:createVault({backend:{read:async()=>structuredClone(row),write:async value=>{row=structuredClone(value);}}})});
    await buyer.createAccount();await until(()=>buyer.state().canSend);
    const makeListing=(index)=>{const author=bots.clients[index===0?0:2].state().ownerPubkey;return {id:`${author}:${index===0?'demo-drone-delivery':'demo-ride'}`,author,title:bots.listings[index].title,side:'offer',price:'0',currency:'EUR'};};
    const parcel=await buyer.requestOrder(makeListing(0)),ride=await buyer.requestOrder(makeListing(1));
    await until(()=>[parcel,ride].every(item=>buyer.state().orders.find(order=>order.id===item.id)?.locationFresh));
    const tracked=buyer.state().orders;
    const parcelState=tracked.find(item=>item.id===parcel.id),rideState=tracked.find(item=>item.id===ride.id);
    assert.notEqual(parcelState.seller,parcelState.shipment.location.courierPubkey);
    assert.equal(rideState.seller,rideState.shipment.location.courierPubkey);
    assert.equal(parcelState.shipment.stops.length,2);assert.equal(rideState.shipment.stops.length,2);
    assert.ok(parcelState.shipment.eta>parcelState.createdAt);
    await buyer.send(rideState.seller,'Is this a real booking?',orderContext(ride.id));
    await until(()=>buyer.state().conversations.some(thread=>thread.messages.some(message=>!message.mine&&message.text.startsWith('Simulated update:')&&message.context?.order_id===ride.id)));
    await until(()=>[parcel,ride].every(item=>buyer.state().orders.find(order=>order.id===item.id)?.status==='delivered'));
    for(const order of buyer.state().orders){assert.ok(order.shipment.stops.every(stop=>stop.status==='completed'));assert.equal(order.shipment.location,undefined);}
    const cancelled=await buyer.requestOrder(makeListing(1));
    await until(()=>buyer.state().orders.find(item=>item.id===cancelled.id)?.locationFresh);
    await buyer.updateOrder(cancelled.id,{status:'cancelled'});
    await until(()=>bots.clients[2].state().orders.find(item=>item.id===cancelled.id)?.status==='cancelled');
    await until(()=>bots.active()===0);
    assert.equal(buyer.state().orders.find(item=>item.id===cancelled.id)?.shipment.location,undefined);
    assert.deepEqual(bots.errors,[]);
  }finally{await buyer?.destroy();await bots?.close();await relay.close();}
});
