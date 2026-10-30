import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startDemoRelay} from '../scripts/demo/relay.ts';
import {startDemoActors} from '../scripts/demo/actors.ts';
import {createMessaging} from '../src/messaging/client.ts';
import {createVault} from '../src/messaging/vault.ts';
import {orderContext} from '../src/message-context.ts';
import {stateFile} from '../scripts/demo/state.ts';
import {finalizeEvent,generateSecretKey} from 'nostr-tools';
async function until(check,timeout=30000){const start=Date.now();while(Date.now()-start<timeout){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Demo restart timed out');}
test('private buyer, bot identities, progressed journey and replies survive full local restart',{timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'iris-demo-'));let relay,bots,buyer,row;
 const password='test-only-password';
 try{
  relay=await startDemoRelay(0,{stateDir:directory});
  const options={relay:relay.url,origin:'http://127.0.0.1:4191',stateDir:directory,password,durationMs:10000,tickMs:70,moneyFactory:async()=>({grant:async()=>({token:'cashuATEST',mint:'https://testnut.cashu.space',amount:'128',unit:'sat'}),redeem:async()=>{},close:async()=>{}})};
  bots=await startDemoActors(options);const identities=bots.clients.map(client=>client.state().ownerPubkey);
  const openBuyer=()=>createMessaging({getRelays:()=>[options.relay],vault:createVault({backend:{read:async()=>structuredClone(row),write:async value=>{row=structuredClone(value);}}})});
  buyer=openBuyer();await buyer.createAccount();await until(()=>buyer.state().canSend);const owner=buyer.state().ownerPubkey;
  const order=await buyer.requestOrder({id:`${identities[2]}:demo-ride`,author:identities[2],title:'Demo ride',side:'offer',price:'8',currency:'TESTSAT'});
  await until(()=>buyer.state().orders.find(item=>item.id===order.id)?.payment);await buyer.send(order.seller,'cashuAPAY8',orderContext(order.id));
  await until(()=>buyer.state().orders.find(item=>item.id===order.id)?.shipment.stops[0]?.status==='completed');
  await buyer.send(identities[2],'Is this a simulation?',orderContext(order.id));
  const replies=()=>buyer.state().conversations.flatMap(thread=>thread.messages).filter(message=>!message.mine&&message.text.startsWith('Simulated update:'));
  await until(()=>replies().length===1);
  const route=buyer.state().orders.find(item=>item.id===order.id).routeId;
  await buyer.destroy();buyer=undefined;await bots.close();bots=undefined;const port=Number(new URL(relay.url).port);await relay.close();relay=undefined;
  relay=await startDemoRelay(port,{stateDir:directory});bots=await startDemoActors(options);
  assert.deepEqual(bots.clients.map(client=>client.state().ownerPubkey),identities);
  buyer=openBuyer();await buyer.restore();assert.equal(buyer.state().ownerPubkey,owner);
  await until(()=>buyer.state().orders.find(item=>item.id===order.id)?.status==='delivered');
  const completed=buyer.state().orders.find(item=>item.id===order.id);assert.equal(completed.routeId,route);assert(completed.shipment.stops.every(stop=>stop.status==='completed'));assert.equal(replies().length,1);assert.deepEqual(bots.errors,[]);
  assert.equal((await stat(directory)).mode&0o077,0);for(const name of await readdir(directory))assert.equal((await stat(join(directory,name))).mode&0o077,0);
 }finally{await buyer?.destroy();await bots?.close();await relay?.close();await rm(directory,{recursive:true,force:true});}
});
test('relay restore rejects invalid signatures and prunes expired events',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'iris-demo-'));let relay;
 try{const file=await stateFile(directory,'relay.json');const secret=generateSecretKey();const event=finalizeEvent({kind:1,created_at:Math.floor(Date.now()/1000),content:'expired',tags:[['expiration','1']]},secret);await file.write([event,{...event,id:'bad'}]);relay=await startDemoRelay(0,{stateDir:directory});assert.equal(relay.eventCount(),0);assert.deepEqual(await file.read(),[]);}finally{await relay?.close();await rm(directory,{recursive:true,force:true});}
});
