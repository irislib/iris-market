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
const {matchFilters,verifyEvent}=require('nostr-tools');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const dir=await mkdtemp(join(tmpdir(),'market-order-interop-'));
const events=new Map(),subscriptions=new Set(),frames=[];
const publish=async event=>{assert(verifyEvent(structuredClone(event)));events.set(event.id,event);frames.push(event);for(const sub of subscriptions)if(matchFilters(sub.filters,event))queueMicrotask(()=>sub.onEvent(event));return {remoteAccepted:true};};
const factory=()=>{const own=new Set();return {
  subscribe(filters,{onEvent}){const sub={filters,onEvent};own.add(sub);subscriptions.add(sub);queueMicrotask(()=>{for(const event of events.values())if(matchFilters(filters,event))onEvent(event);});return {close(){own.delete(sub);subscriptions.delete(sub);}};},
  async query(filters){return {events:[...events.values()].filter(e=>matchFilters(filters,e)),complete:true,sources:[]};},publish,
  close(){for(const sub of own)subscriptions.delete(sub);own.clear();}
};};
let row;
const vault=createVault({backend:{read:async()=>structuredClone(row),write:async(value,expected)=>{if(expected!==undefined&&(row?.version??0)!==expected)throw Error('vault conflict');row=structuredClone(value);}}});
const app=createMessaging({vault,getRelays:()=>['wss://test.invalid'],transportFactory:factory});
const waitFor=async predicate=>{const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw Error('Interop condition timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
async function native(extra={}) {
  const authorization=[...events.values()].filter(e=>e.kind===37368&&e.pubkey===app.state().ownerPubkey).at(-1);
  const invite=[...events.values()].filter(e=>e.kind===30078&&e.pubkey===app.state().devicePubkey).at(-1);
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
  const order=await app.requestOrder({id:`${initial.owner_public_key}:synthetic-delivery`,author:initial.owner_public_key,title:'Cross-platform delivery',price:'12',currency:'EUR',side:'offer'},{quantity:2,note:'Synthetic private note'});
  await waitFor(()=>frames.slice(before).some(e=>e.kind===1060));
  const incoming=frames.slice(before).filter(e=>[1059,1060].includes(e.kind));
  const accepted=await native({incoming,expected_order:order.id,order_patch:{status:'accepted'}});
  assert.equal(accepted.orders[0].items[0].quantity,2);
  await waitFor(()=>app.state().orders.find(o=>o.id===order.id)?.status==='accepted');
  const routed=await native({expected_order:order.id,order_patch:{shipment:{stops:[{id:'pickup',label:'Pickup',address:'Private synthetic address',coordinates:[24.94,60.17]}],trackingUrl:'https://tracking.example/test'}}});
  await waitFor(()=>app.state().orders.find(o=>o.id===order.id)?.shipment.stops.length===1);
  assert.equal(app.state().orders[0].shipment.stops[0].address,'Private synthetic address');
  assert(routed.outgoing.every(e=>!JSON.stringify(e).includes('Private synthetic address')));
  console.log('PASS: actual JS request → Rust accept/route → JS projection; authenticated NDR, no network');
} finally { await app.destroy();await rm(dir,{recursive:true,force:true}); }
