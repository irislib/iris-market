import test from 'node:test';
import assert from 'node:assert/strict';
import {startDemoActors} from '../scripts/demo/actors.ts';
import {demoListingDraft,DEMO_LISTING_LIFETIME,DEMO_RENEW_AFTER} from '../scripts/demo/listings.ts';
import {DEFAULT_RELAYS,parseEvent,applyEvent,visibleListings} from '../src/market.ts';
import {privateRelayUrls} from '../src/messaging/transport.ts';
import {finalizeEvent,generateSecretKey} from 'nostr-tools';

test('public demo rejects unsafe configuration before opening storage or network',async()=>{
  // Every case rejects before actor creation; no valid public actor is started.
  const base={publicRelays:['wss://relay.example'],origin:'https://market.iris.to',stateDir:'/unused-public-demo-test',password:'offline-test-password'};
  for(const override of [
    {stateDir:undefined},{relay:'ws://127.0.0.1:4789'},
    {origin:'http://market.iris.to'},{origin:'https://market.iris.to.example'},
    {publicRelays:[]},{publicRelays:['ws://127.0.0.1:4789']},
    {publicRelays:['ws://relay.example']},{publicRelays:['https://relay.example']},
    {publicRelays:['wss://user:password@relay.example']},{publicRelays:['wss://relay.example/#fragment']},
    {publicRelays:Array.from({length:9},(_,index)=>`wss://relay${index}.example`)},
    {password:undefined},{password:'short'},
  ])await assert.rejects(startDemoActors({...base,...override}),/require|Choose|Invalid/);
  assert.deepEqual(privateRelayUrls([...DEFAULT_RELAYS]),DEFAULT_RELAYS.map(value=>new URL(value).href));
  assert(DEFAULT_RELAYS.every(value=>new URL(value).protocol==='wss:'));
});

test('public demo listings validate as signed test-money simulations, expire and renew',()=>{
  const createdAt=1800000000,secret=generateSecretKey();
  assert(DEMO_RENEW_AFTER>0&&DEMO_RENEW_AFTER<DEMO_LISTING_LIFETIME);
  for(const kind of ['product','ride','delivery']) {
    const event=finalizeEvent(demoListingDraft(kind,createdAt,true),secret),listing=parseEvent(event,{now:createdAt});
    assert.equal(listing.identifier,kind==='product'?'demo-drone-delivery':kind==='ride'?'demo-ride':'demo-courier');
    assert.equal(listing.side,'offer');assert.equal(listing.price,kind==='product'?'16':'8');assert.equal(listing.currency,'TESTSAT');
    assert.equal(listing.imageUrl,`https://market.iris.to/demo-${kind==='ride'?'ride':'delivery'}.svg`);
    assert.equal(listing.expiration,createdAt+DEMO_LISTING_LIFETIME);
    assert.match(listing.description,/https:\/\/market\.iris\.to/);
    assert.match(listing.description,/Simulation only: no real/);
    assert.match(listing.description,/your location is not used/);
    assert.match(listing.description,/One active demo per person/);
    assert(!listing.description.includes('test-relay'));
    const records=new Map();applyEvent(records,event,{now:createdAt});
    assert.equal(visibleListings(records,{now:createdAt}).length,1);
    assert.equal(visibleListings(records,{now:listing.expiration+1}).length,0);
    const renewed=finalizeEvent(demoListingDraft(kind,createdAt+DEMO_RENEW_AFTER,true),secret);
    applyEvent(records,renewed,{now:createdAt+DEMO_RENEW_AFTER});
    assert.equal(records.get(listing.id).eventId,renewed.id);
    assert.equal(visibleListings(records,{now:listing.expiration+1}).length,1);
    const local=demoListingDraft(kind,createdAt);
    assert(!local.tags.some(tag=>['expiration','image'].includes(tag[0])));
    assert.match(local.content,/local preview is only available here/);
  }
});

test('public actors serve concurrent customers privately and drain each buyer queue through offline WSS mapping',{timeout:45000},async()=>{
  const [{mkdtemp,rm},{tmpdir},{join},{startDemoRelay},{createMessaging},{createVault},{orderContext}]=await Promise.all([
    import('node:fs/promises'),import('node:os'),import('node:path'),import('../scripts/demo/relay.ts'),
    import('../src/messaging/client.ts'),import('../src/messaging/vault.ts'),import('../src/message-context.ts'),
  ]);
  const directory=await mkdtemp(join(tmpdir(),'iris-public-offline-')),relay=await startDemoRelay(0);
  const OriginalWebSocket=globalThis.WebSocket,urls=[];let bots,buyer,row,secondBuyer,secondRow;
  const endpoint='wss://demo.example/';let clock=0;
  globalThis.WebSocket=class extends OriginalWebSocket {
    constructor(url,...args){urls.push(String(url));if(String(url)!==endpoint)throw Error('Unexpected network destination in offline demo test');super(relay.url,...args);}
  };
  const until=async(check,timeout=30000)=>{const started=Date.now();while(Date.now()-started<timeout){if(check())return;await new Promise(resolve=>setTimeout(resolve,35));}throw Error('Public offline demo timed out');};
  try {
    bots=await startDemoActors({publicRelays:[endpoint],origin:'https://market.iris.to',stateDir:directory,password:'offline-public-test-password',tickMs:60,durationMs:9000,clockMs:()=>clock,moneyFactory:async()=>({grant:async()=>({token:'cashuATEST',mint:'https://testnut.cashu.space',amount:'128',unit:'sat'}),redeem:async()=>{},close:async()=>{}})});
    assert(bots.listings.every(item=>new URL(item.url).origin==='https://market.iris.to'&&!item.url.includes('test-relay')));
    buyer=createMessaging({getRelays:()=>[endpoint],vault:createVault({backend:{read:async()=>structuredClone(row),write:async value=>{row=structuredClone(value);}}})});
    await buyer.createAccount();await until(()=>buyer.state().canSend);
    secondBuyer=createMessaging({getRelays:()=>[endpoint],vault:createVault({backend:{read:async()=>structuredClone(secondRow),write:async value=>{secondRow=structuredClone(value);}}})});
    await secondBuyer.createAccount();await until(()=>secondBuyer.state().canSend);
    const listing=kind=>{const author=bots.clients[kind==='ride'?2:1].state().ownerPubkey;return {id:`${author}:${kind==='product'?'demo-drone-delivery':kind==='ride'?'demo-ride':'demo-courier'}`,author,title:'Free public demo',side:'offer',price:'8',currency:'TESTSAT'};};
    const parcel=await buyer.requestOrder(listing('ride'));
    const pay=async(client,order)=>{await until(()=>client.state().orders.find(item=>item.id===order.id)?.payment);await client.send(order.seller,'cashuAPAY8',orderContext(order.id));};await pay(buyer,parcel);
    await until(()=>buyer.state().orders.find(item=>item.id===parcel.id)?.locationFresh);
    const otherRide=await secondBuyer.requestOrder(listing('ride'));await pay(secondBuyer,otherRide);
    await until(()=>secondBuyer.state().orders.find(item=>item.id===otherRide.id)?.locationFresh);
    assert.equal(bots.active(),2);
    assert(!buyer.state().orders.some(item=>item.id===otherRide.id));
    assert(!secondBuyer.state().orders.some(item=>item.id===parcel.id));
    const ride=await buyer.requestOrder(listing('ride'));await pay(buyer,ride);
    await until(()=>bots.clients[2].state().orders.some(item=>item.id===ride.id));
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(bots.active(),2);
    assert.equal(bots.clients[2].state().orders.find(item=>item.id===ride.id).status,'requested');
    await buyer.send(listing('ride').author,'Is this just a simulation?',orderContext(parcel.id));
    await until(()=>buyer.state().conversations.some(thread=>thread.messages.some(message=>!message.mine&&message.text.startsWith('Simulated update:')&&message.context?.order_id===parcel.id)));
    assert.equal(bots.replyStats().ollama,0);assert(bots.replyStats().scripted>=1);
    clock=10000;
    await until(()=>buyer.state().orders.find(item=>item.id===parcel.id)?.status==='delivered');
    await until(()=>buyer.state().orders.find(item=>item.id===ride.id)?.locationFresh);
    clock=20000;
    await until(()=>buyer.state().orders.find(item=>item.id===ride.id)?.status==='delivered');
    await until(()=>secondBuyer.state().orders.find(item=>item.id===otherRide.id)?.status==='delivered');
    await until(()=>bots.active()===0);
    const paid=await buyer.requestOrder({...listing('ride'),price:'1'});
    const multiple=await buyer.requestOrder(listing('delivery'),{quantity:2});
    await until(()=>[paid,multiple].every(order=>buyer.state().orders.find(item=>item.id===order.id)?.status==='cancelled'));
    assert.deepEqual(bots.errors,[]);
    assert(urls.length>0);assert(urls.every(url=>url===endpoint));
  }finally{
    try{await buyer?.destroy();await secondBuyer?.destroy();await bots?.close();await relay.close();}
    finally{globalThis.WebSocket=OriginalWebSocket;await rm(directory,{recursive:true,force:true});}
  }
});
