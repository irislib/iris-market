import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools/pure';
import {matchingBitcoinOrders,mergeBitcoinOrders,orderFilters,readBitcoinOrder} from '../src/bitcoin-orders.ts';
import {createPublicRuntime} from '../src/nostr-runtime.ts';

const key=generateSecretKey(),author=getPublicKey(key),id='f8a49651-3dff-4f84-8af4-c2c98c54f954',now=1800000000;
const source='mostro:'+id+'?mostro='+author;
const fields={d:[id],z:['order'],y:['mostro','instance'],s:['pending'],k:['sell'],network:['mainnet'],layer:['lightning'],amt:['0'],fa:['100','250'],f:['EUR'],pm:['SEPA','cash'],premium:['-1.5'],source:[source],expires_at:[String(now+60)],expiration:[String(now+90)]};
function signed(overrides={},created=now){return finalizeEvent({kind:38383,content:'',created_at:created,tags:Object.entries({...fields,...overrides}).filter(([,values])=>values).map(([k,values])=>[k,...values])},key)}
test('public orders need no Iris title, photo, fixed sats or platform allowlist',()=>{
 const bid=signed({y:['A new exchange'],k:['buy'],source:['https://example.com/order/1'],d:['another']});
 const book=new Map();mergeBitcoinOrders(book,[signed(),bid],now);
 assert.equal(matchingBitcoinOrders(book,'btc sepa','offer',now)[0].quote.source.href,source);
 assert.deepEqual(matchingBitcoinOrders(book,'bitcoin EUR','request',now).map(o=>o.quote.platform),['A new exchange']);
 assert.deepEqual(readBitcoinOrder(signed()).quote.amounts,[100,250]);
 assert.equal(readBitcoinOrder(signed()).quote.quantity,null);
 assert.equal(readBitcoinOrder(signed()).quote.premium,-1.5);
 assert.equal(matchingBitcoinOrders(book,'bitcoin mining rig','all',now).length,0);
 assert.equal(matchingBitcoinOrders(book,'bitcoin','all',now+60).length,0);
 assert(orderFilters.every(f=>!f['#y']&&!f.search));
});
test('terminal and invalid winning quotes supersede older pending orders',()=>{
 const old=signed(),book=new Map(),closed=signed({s:['canceled'],fa:null,source:null},now+1);
 for(const event of [closed,old])mergeBitcoinOrders(book,[event],now+1);
 assert.equal(matchingBitcoinOrders(book,'bitcoin','offer',now+1).length,0);
 for(const terms of [{network:['testnet']},{fa:['250','20']},{expiration:['bad']},{k:['maybe']},{y:['iris-market']}]){
   assert.equal(readBitcoinOrder(signed(terms)).quote,null);
 }
 for(const link of ['javascript:alert(1)','https://name:pass@example.org','mostro:'+id+'?mostro='+'0'.repeat(64)]){
   assert.equal(readBitcoinOrder(signed({source:[link]})).quote.source,undefined);
 }
});
test('public discovery verifies external signatures and keeps external orders out of Iris publishing',async()=>{
 const ev=signed(),tampered={...ev,content:'changed'};
 let delivered=[];const runtime=createPublicRuntime({relays:[],createClient:async()=>({
   init:async()=>{},close:async()=>{},queryEvents:async()=>({events:[ev,tampered]})
 })});
 try{
   delivered=(await runtime.query(orderFilters)).events;
   assert.deepEqual(delivered.map(x=>x.content),['']);
   await assert.rejects(runtime.publish(ev),/Invalid public event/);
 }finally{runtime.close()}
});
