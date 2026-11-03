import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,generateSecretKey,getPublicKey} from 'nostr-tools/pure';
import {mergeBitcoinOrders,orderFilters,readBitcoinOrder,orderListing} from '../src/bitcoin-orders.ts';
import {matchesLiteralSearch} from '../src/lexical-search.ts';
import {createBitcoinOrderFeed,orderHistoryState} from '../src/bitcoin-order-feed.ts';
import {createPublicRuntime} from '../src/nostr-runtime.ts';

const key=generateSecretKey(),author=getPublicKey(key),id='f8a49651-3dff-4f84-8af4-c2c98c54f954',now=1800000000;
const source='mostro:'+id+'?mostro='+author;
const fields={d:[id],z:['order'],y:['mostro','instance'],s:['pending'],k:['sell'],network:['mainnet'],layer:['lightning'],amt:['0'],fa:['100','250'],f:['EUR'],pm:['SEPA','cash'],premium:['-1.5'],source:[source],expires_at:[String(now+60)],expiration:[String(now+90)]};
function signed(overrides={},created=now){return finalizeEvent({kind:38383,content:'',created_at:created,tags:Object.entries({...fields,...overrides}).filter(([,values])=>values).map(([k,values])=>[k,...values])},key)}
test('public orders need no Iris title, photo, fixed sats or platform allowlist',()=>{
 const bid=signed({y:['A new exchange'],k:['buy'],source:['https://example.com/order/1'],d:['another']});
 const book=new Map();mergeBitcoinOrders(book,[signed(),bid],now);
 const [listing,buy]=[...book.values()].map(orderListing);
 assert(matchesLiteralSearch(listing.externalOrder.search,'btc sepa'));
 assert.equal(listing.id,'38383:'+author+':'+id);assert.equal(listing.title,'Selling bitcoin for EUR');
 assert(!Object.hasOwn(listing.externalOrder,'source'));
 assert.equal(buy.side,'request');assert.equal(buy.externalOrder.platform,'A new exchange');
 assert.deepEqual(readBitcoinOrder(signed()).quote.amounts,[100,250]);
 assert.equal(readBitcoinOrder(signed()).quote.quantity,null);
 assert.equal(readBitcoinOrder(signed()).quote.premium,-1.5);
 assert(!matchesLiteralSearch(listing.externalOrder.search,'bitcoin mining rig'));
 assert.equal(listing.expiration,now+60);
 assert(orderFilters.every(f=>!f['#y']&&!f.search));
});
test('terminal and invalid winning quotes supersede older pending orders',()=>{
 const old=signed(),book=new Map(),closed=signed({s:['canceled'],fa:null,source:null},now+1);
 for(const event of [closed,old])mergeBitcoinOrders(book,[event],now+1);
 assert.equal(orderListing([...book.values()][0]),undefined);
 for(const terms of [{network:['testnet']},{fa:['250','20']},{expiration:['bad']},{k:['maybe']}]){
   assert.equal(readBitcoinOrder(signed(terms)).quote,null);
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


test('a slow initial history remains live and exposes a late verified order on its Iris page',()=>{
 const timeout={reason:'timeout',complete:false,sources:[{id:'relay',complete:false,error:'Historical query is incomplete'}]};
 assert.equal(orderHistoryState(timeout,false),'delayed');
 assert.equal(orderHistoryState({...timeout,reason:'unavailable'},false),'unavailable');
 assert.equal(orderHistoryState({...timeout,reason:'unavailable'},true),'ready');
 const listeners=[],requests=[];
 const runtime={close(){},subscribe(filters,handlers){listeners.push(handlers);requests.push(filters);return{close(){}}}};
 const feed=createBitcoinOrderFeed(()=>{},()=>runtime),created=Math.floor(Date.now()/1000);
 const ev=signed({expires_at:[String(created+300)],expiration:[String(created+400)]},created);
 const address='38383:'+author+':'+id;
 try{
   feed.sync('search',['wss://example.com'],false);
   listeners[0].onEose(timeout);assert.equal(feed.state(),'delayed');
   listeners[0].onError(Error('worker reconnecting'));assert.equal(feed.state(),'delayed');
   listeners[0].onEvent(ev);assert.equal(feed.state(),'ready');assert.equal(feed.listings()[0].id,address);
   feed.sync(address,['wss://example.com'],false);
   assert.deepEqual(requests[1],[{kinds:[38383],authors:[author],'#d':[id],limit:1}]);
   assert.equal(feed.get(address).externalOrder.platform,'mostro');
   listeners[1].onEvent(signed({s:['canceled']},created+1));assert.equal(feed.get(address),undefined);
   listeners[0].onEvent(ev);assert.equal(feed.listings().length,0);
 }finally{feed.stop()}
});
