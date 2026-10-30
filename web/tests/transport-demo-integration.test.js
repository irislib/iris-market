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
test('paid product, separate courier and ride: private orders, chat, tracking and cancellation',{timeout:60000},async()=>{
  const relay=await startDemoRelay(0);let bots,buyer,row;
  try {
    bots=await startDemoActors({relay:relay.url,origin:'http://127.0.0.1:4191',durationMs:5000,tickMs:100,moneyFactory:async()=>({validatePayment:(token,amount)=>{if(token!==`cashuAPAY${amount}`)throw Error('Wrong amount');},grant:async()=>({token:'cashuATEST',mint:'https://testnut.cashu.space',amount:'128',unit:'sat'}),redeem:async(id,token,amount)=>{if(token!==`cashuAPAY${amount}`)throw Error('Wrong amount');},close:async()=>{}})});
    for(const listing of bots.listings)assert.equal(parseEvent(listing.event).title,listing.title);
    buyer=createMessaging({getRelays:()=>[relay.url],vault:createVault({backend:{read:async()=>structuredClone(row),write:async value=>{row=structuredClone(value);}}})});
    await buyer.createAccount();await until(()=>buyer.state().canSend);
    const makeListing=(index)=>{const author=bots.clients[index].state().ownerPubkey;return {id:`${author}:${['demo-drone-delivery','demo-courier','demo-ride'][index]}`,author,title:bots.listings[index].title,side:'offer',price:index===0?'16':'8',currency:'TESTSAT'};};
    const pay=async order=>{await until(()=>buyer.state().orders.find(item=>item.id===order.id)?.payment?.status==='requested');assert.equal(buyer.state().orders.find(item=>item.id===order.id).status,'requested');await buyer.send(order.seller,`cashuAPAY${order.items[0].price}`,orderContext(order.id));};
    const product=await buyer.requestOrder(makeListing(0));
    await until(()=>buyer.state().orders.find(item=>item.id===product.id)?.payment);await buyer.send(product.seller,'cashuAPAY7',orderContext(product.id));
    await until(()=>buyer.state().conversations.some(t=>t.messages.some(m=>m.text.includes('could not be verified'))));assert.equal(buyer.state().orders.find(item=>item.id===product.id).status,'requested');assert.equal(bots.active(),0);await pay(product);
    await until(()=>buyer.state().orders.find(item=>item.id===product.id)?.shipment.stops.length===1);
    const productState=buyer.state().orders.find(item=>item.id===product.id);assert.equal(productState.shipment.location,undefined);assert.equal(productState.shipment.stops[0].courierPubkey,undefined);assert.equal(productState.payment.status,'received');
    const parcel=await buyer.requestOrder(makeListing(1),{deliveryRequest:{pickup:{label:'Shop',address:'Market Square demo pickup',coordinates:[24.952,60.167]},destination:{label:'Destination',address:'Kaisaniemi demo dropoff',coordinates:[24.947,60.176]},collection:{merchant:product.seller,reference:'demo-collection'}}}),ride=await buyer.requestOrder(makeListing(2));
    await pay(parcel);await pay(ride);
    assert.equal(bots.clients[1].state().orders.some(item=>item.id===product.id),false);
    await until(()=>[parcel,ride].every(item=>buyer.state().orders.find(order=>order.id===item.id)?.locationFresh));
    const tracked=buyer.state().orders;
    const parcelState=tracked.find(item=>item.id===parcel.id),rideState=tracked.find(item=>item.id===ride.id);
    assert.equal(parcelState.seller,parcelState.shipment.location.courierPubkey);
    assert.equal(rideState.seller,rideState.shipment.location.courierPubkey);
    assert.equal(parcelState.shipment.stops.length,2);assert.equal(rideState.shipment.stops.length,2);
    assert.ok(parcelState.shipment.eta>parcelState.createdAt);
    await buyer.send(rideState.seller,'Is this a real booking?',orderContext(ride.id));
    await until(()=>buyer.state().conversations.some(thread=>thread.messages.some(message=>!message.mine&&message.text.startsWith('Simulated update:')&&message.context?.order_id===ride.id)));
    await until(()=>[parcel,ride].every(item=>buyer.state().orders.find(order=>order.id===item.id)?.status==='delivered'));
    for(const order of buyer.state().orders.filter(item=>item.id!==product.id)){assert.ok(order.shipment.stops.every(stop=>stop.status==='completed'));assert.equal(order.shipment.location,undefined);}
    const cancelled=await buyer.requestOrder(makeListing(2));await pay(cancelled);
    await until(()=>buyer.state().orders.find(item=>item.id===cancelled.id)?.locationFresh);
    await buyer.updateOrder(cancelled.id,{status:'cancelled'});
    await until(()=>bots.clients[2].state().orders.find(item=>item.id===cancelled.id)?.status==='cancelled');
    await until(()=>bots.active()===0);
    assert.equal(buyer.state().orders.find(item=>item.id===cancelled.id)?.shipment.location,undefined);
    assert.deepEqual(bots.errors,[]);
  }finally{await buyer?.destroy();await bots?.close();await relay.close();}
});


test('payment retries transient mint and order persistence failures without another grant',{timeout:30000},async()=>{
  const relay=await startDemoRelay(0);let bots,buyer,row;let grants=0,attempts=0,awards=0,projectionFailures=0;const receipts=new Set();
  try{
    bots=await startDemoActors({relay:relay.url,origin:'http://127.0.0.1:4191',tickMs:50,moneyFactory:async()=>({
      grant:async()=>{grants++;return {token:'cashuATEST',mint:'https://testnut.cashu.space',amount:'128',unit:'sat'};},
      redeem:async id=>{attempts++;if(attempts===1)throw Error('Temporary mint outage');if(!receipts.has(id)){receipts.add(id);awards++;}},close:async()=>{},
    })});
    const seller=bots.clients[0],originalUpdate=seller.updateOrder;
    seller.updateOrder=async(id,patch)=>{if(patch.payment?.status==='received'&&projectionFailures++===0)throw Error('Temporary encrypted store failure after redemption');return originalUpdate(id,patch);};
    buyer=createMessaging({getRelays:()=>[relay.url],vault:createVault({backend:{read:async()=>structuredClone(row),write:async next=>{row=structuredClone(next);}}})});await buyer.createAccount();await until(()=>buyer.state().canSend);
    const author=seller.state().ownerPubkey;
    const order=await buyer.requestOrder({id:`${author}:demo-drone-delivery`,author,title:'Demo imaginary parcel',price:'16',currency:'TESTSAT',side:'offer'});
    await until(()=>buyer.state().orders.find(item=>item.id===order.id)?.payment?.status==='requested');
    await buyer.send(author,'cashuAPAY16',orderContext(order.id));
    await until(()=>buyer.state().orders.find(item=>item.id===order.id)?.shipment.stops.length===1);
    assert.equal(buyer.state().orders.find(item=>item.id===order.id).payment.status,'received');assert.equal(buyer.state().orders.find(item=>item.id===order.id).status,'accepted');
    assert.equal(attempts,3);assert.equal(awards,1);assert.equal(grants,1);assert.equal(projectionFailures,2);
    const texts=buyer.state().conversations.flatMap(thread=>thread.messages).filter(message=>!message.mine).map(message=>message.text);
    assert(!texts.some(text=>text.startsWith('Simulated update:')));assert(!texts.some(text=>text.includes('could not be verified')));assert.deepEqual(bots.errors,[]);
  }finally{await buyer?.destroy();await bots?.close();await relay.close();}
});
