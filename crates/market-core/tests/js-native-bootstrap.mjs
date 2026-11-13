// Actual fresh Market bootstrap -> strict JS peer, through a localhost-only relay.
// Synthetic keys/data only. No manual native roster injection, public relay or payment.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createMessaging} from '../../../web/src/messaging/client.ts';
import {createVault} from '../../../web/src/messaging/vault.ts';
const require=createRequire(new URL('../../../web/package.json',import.meta.url));
const {WebSocketServer}=require('ws');
const {matchFilters,verifyEvent}=require('nostr-tools');
const events=new Map(),subscriptions=new Map();
const server=new WebSocketServer({host:'127.0.0.1',port:0});
const silentServer=new WebSocketServer({host:'127.0.0.1',port:0});
function connectRelay(socket,acknowledge) {
  subscriptions.set(socket,new Map());
  socket.on('close',()=>subscriptions.delete(socket));
  socket.on('message',raw=>{
    try {
      const [type,id,...filters]=JSON.parse(raw.toString());
      if(type==='REQ') {
        subscriptions.get(socket).set(id,filters);
        for(const event of events.values())if(matchFilters(filters,event))socket.send(JSON.stringify(['EVENT',id,event]));
        if(acknowledge)socket.send(JSON.stringify(['EOSE',id]));
      } else if(type==='CLOSE') subscriptions.get(socket).delete(id);
      else if(type==='EVENT'&&verifyEvent(id)) {
        events.set(id.id,id);if(acknowledge)socket.send(JSON.stringify(['OK',id.id,true,'']));
        for(const [target,subs] of subscriptions)for(const [sub,filter] of subs)if(matchFilters(filter,id))target.send(JSON.stringify(['EVENT',sub,id]));
      }
    } catch { /* Ignore malformed fixture traffic. */ }
  });
}
server.on('connection',socket=>connectRelay(socket,true));
silentServer.on('connection',socket=>connectRelay(socket,false));
await Promise.all([server,silentServer].map(relay=>new Promise(resolve=>relay.once('listening',resolve))));
const relay=`ws://127.0.0.1:${server.address().port}`;
let row,seller,routing=false,child;
const legacy=process.argv.includes('--legacy');
const accepted=new Set();
async function acceptOrders() {
  if(routing||!seller)return;routing=true;
  try {
    for(const order of seller.state().orders||[])if(order.status==='requested'&&!accepted.has(order.id)) {
      accepted.add(order.id);await seller.updateOrder(order.id,{status:'accepted'});
    }
  } finally { routing=false; }
}
const waitFor=async predicate=>{
  const end=Date.now()+10000;
  while(!predicate()) {assert(Date.now()<end,'Strict JS fixture failed to become ready');await new Promise(resolve=>setTimeout(resolve,20));}
};
try {
  seller=createMessaging({getRelays:()=>[relay],vault:createVault({backend:{
    read:async()=>structuredClone(row),write:async(value,expected)=>{assert.equal(row?.version??0,expected);row=structuredClone(value);}
  }}),onChange:()=>queueMicrotask(()=>void acceptOrders().catch(()=>{}))});
  await seller.createAccount();
  await waitFor(()=>seller.state().canSend&&[...events.values()].some(event=>event.kind===30078));
  await seller.publishEvent({kind:30402,created_at:Math.floor(Date.now()/1000),tags:[['d','fresh-native-test'],['title','Fresh native delivery'],['price','12','EUR'],['location','Synthetic test']],content:'Private localhost integration fixture.'});
  await waitFor(()=>[...events.values()].some(event=>event.kind===30402));
  child=spawn('cargo',['test','--locked','-p','iris-market-core','--test','js_interop','fresh_native_profile_orders_with_strict_js_peer','--','--ignored','--exact'],{
    cwd:fileURLToPath(new URL('../../../',import.meta.url)),stdio:['ignore','inherit','inherit'],env:{...process.env,CARGO_BUILD_JOBS:'2',MARKET_NATIVE_RELAY:relay,MARKET_NATIVE_SELLER:seller.state().ownerPubkey,MARKET_NATIVE_SILENT_RELAY:`ws://127.0.0.1:${silentServer.address().port}`,...(legacy?{MARKET_TEST_OWNER_KEY_SESSION:'1'}:{})}
  });
  const timer=setTimeout(()=>child.kill('SIGTERM'),90000);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timer);
  assert.equal(code,0,'Fresh native profile order exchange failed');
  assert.equal(accepted.size,1);
  if(!legacy)assert([...events.values()].filter(event=>event.kind===37368).length>=2,'Native app did not publish its signed roster');
  if(legacy)assert.equal([...events.values()].filter(e=>e.kind===37368&&e.pubkey!==seller.state().ownerPubkey).length,0,'Buyer was silently enrolled');
  assert([...events.values()].filter(e=>e.kind===1060).every(e=>e.tags.every(t=>t[0]!=='p')),'A private message disclosed its recipient');
  console.log(legacy?'PASS: seller replied to an authenticated native buyer without device enrollment':'PASS: fresh native app -> strict JS accepted order, localhost only, accepting and silent relays, no pre-seeded native authorization');
} finally {
  if(child&&child.exitCode===null)child.kill('SIGTERM');
  await seller?.destroy();for(const relay of [server,silentServer])for(const socket of relay.clients)socket.terminate();
  await Promise.all([server,silentServer].map(relay=>new Promise(resolve=>relay.close(resolve))));
}
