import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import type {RuntimeCompletion} from 'nostr-pubsub';
import {createPublicRuntime} from './nostr-runtime.ts';
import {BITCOIN_KIND} from './escrow-offer.ts';
import {BITCOIN_ORDER_RELAY,mergeBitcoinOrders,orderFilters,orderListing,readBitcoinOrder} from './bitcoin-orders.ts';

type Order=NonNullable<ReturnType<typeof readBitcoinOrder>>;
type LoadState='waiting'|'delayed'|'ready'|'unavailable';
export function orderHistoryState(status:RuntimeCompletion,received:boolean):LoadState {
  if(received||status.complete||status.sources.some(source=>source.complete))return 'ready';
  return status.reason==='unavailable'?'unavailable':'delayed';
}

export function createBitcoinOrderFeed(onChange:()=>void,openRuntime=createPublicRuntime) {
  const book=new Map<string,Order>();
  let runtime:ReturnType<typeof createPublicRuntime>,subscription:{close():void};
  let relayKey='',interest='',generation=0,received=false,state:LoadState='waiting';
  let notifyTimer:ReturnType<typeof setTimeout>,expiryTimer:ReturnType<typeof setTimeout>;
  const now=()=>Math.floor(Date.now()/1000);
  function changed(){
    if(notifyTimer===undefined)notifyTimer=setTimeout(()=>{notifyTimer=undefined;onChange()},40);
  }
  function stop(){
    generation++;subscription?.close();subscription=undefined;runtime?.close();runtime=undefined;
    clearTimeout(expiryTimer);clearTimeout(notifyTimer);notifyTimer=undefined;interest='';
  }
  function sync(wanted:string,relays:readonly string[],useOrderRelay:boolean,savedIds?:ReadonlySet<string>){
    if(!wanted){if(runtime)stop();return}
    const urls=useOrderRelay?[...new Set([...relays,BITCOIN_ORDER_RELAY])]:relays;
    const key=JSON.stringify([...urls].sort());
    if(key!==relayKey){stop();book.clear();relayKey=key}
    if(interest===wanted)return;
    if(!runtime)runtime=openRuntime({relays:urls,storeName:'iris-market-p2p-orders-v1-'+bytesToHex(sha256(new TextEncoder().encode(key)))});
    const active=++generation;
    subscription?.close();interest=wanted;received=false;state='waiting';
    // Exact shared addresses get their latest revision independently of order-book limits.
    const filters=wanted.startsWith('38383:')?[{kinds:[BITCOIN_KIND],authors:[wanted.slice(6,70)],'#d':[wanted.slice(71)],limit:1}]:orderFilters;
    subscription=runtime.subscribe(filters,{
      onEvent(event){
        if(generation!==active)return;
        const transitioned=state!=='ready';received=true;state='ready';
        if(mergeBitcoinOrders(book,[event],now())||transitioned)changed();
      },
      onEose(status){if(generation===active){state=orderHistoryState(status,received);changed()}},
      onError(){if(generation===active&&!received&&state!=='unavailable'){state='delayed';changed()}},
    });
    if(wanted==='saved'&&savedIds){
      // Restore saved quotes from this relay scope without revealing the saved list to relays.
      const ids=[...savedIds].filter(id=>id.startsWith('38383:')).map(id=>id.slice(71));
      for(let i=0;i<ids.length;i+=64){
        void runtime.query([{kinds:[BITCOIN_KIND],'#d':ids.slice(i,i+64)}],{cache:'cache-only',limit:256})
          .then(({events})=>{if(generation===active&&mergeBitcoinOrders(book,events,now()))changed()})
          .catch(()=>{/* The live subscription can still supply these quotes. */});
      }
    }
  }
  function wakeAtExpiry(expires:number){
    clearTimeout(expiryTimer);
    if(runtime&&Number.isFinite(expires))expiryTimer=setTimeout(changed,Math.min(2147483647,Math.max(0,expires*1000-Date.now())+1));
  }
  function listings(){
    const at=now(),rows=[];
    let nextExpiry=Infinity;
    for(const order of book.values()){
      if(!order.quote||order.quote.expires<=at)continue;
      rows.push(orderListing(order));nextExpiry=Math.min(nextExpiry,order.quote.expires);
    }
    wakeAtExpiry(nextExpiry);
    return rows;
  }
  function get(id:string){
    const order=book.get(id);
    if(!order?.quote||order.quote.expires<=now())return;
    if(interest===id)wakeAtExpiry(order.quote.expires);
    return orderListing(order);
  }
  return {sync,stop,listings,get,known:(id:string)=>book.has(id),state:()=>state};
}
