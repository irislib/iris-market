import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {matchesLiteralSearch} from './lexical-search.ts';
import {element} from './dom.ts';
import {createPublicRuntime} from './nostr-runtime.ts';
import {BITCOIN_ORDER_RELAY,matchingBitcoinOrders,mergeBitcoinOrders,orderFilters,readBitcoinOrder} from './bitcoin-orders.ts';

export function setupBitcoinOrders(root:HTMLElement,onChange:()=>void) {
  const book=new Map<string,NonNullable<ReturnType<typeof readBitcoinOrder>>>();
  let scope='',view='',painted='',limit=4,failed=false;
  let runtime:ReturnType<typeof createPublicRuntime>,subscription:{close():void};
  let timer:ReturnType<typeof setTimeout>,expiry:ReturnType<typeof setTimeout>;
  const now=()=>Math.floor(Date.now()/1000);
  // Coalesce a relay burst into one paint while delivering the first rows immediately.
  function changed(){
    if(timer===undefined)timer=setTimeout(()=>{timer=undefined;onChange()},40);
  }
  function stop(){
    scope='';subscription?.close();runtime?.close();runtime=undefined;subscription=undefined;
    clearTimeout(timer);clearTimeout(expiry);timer=undefined;book.clear();failed=false;view='';painted='';root.hidden=true;root.replaceChildren();
  }
  function update(query:string,side:string,relays:readonly string[],useOrderRelay:boolean){
    if(!query){if(scope)stop();return 0}
    const urls=useOrderRelay?[...new Set([...relays,BITCOIN_ORDER_RELAY])]:relays;
    const nextScope=JSON.stringify([...urls].sort());
    if(scope!==nextScope){
      stop();scope=nextScope;
      runtime=createPublicRuntime({relays:urls,storeName:'iris-market-p2p-orders-v1-'+bytesToHex(sha256(new TextEncoder().encode(nextScope)))});
      subscription=runtime.subscribe(orderFilters,{onEvent(event){
        if(scope!==nextScope)return;
        failed=false;
        if(mergeBitcoinOrders(book,[event],now()))changed();
      },onEose(status){
        if(scope!==nextScope)return;
        failed=!status.complete&&!status.sources.some(source=>source.complete);
        changed();
      },onError(){if(scope===nextScope){failed=true;changed()}}});
    }
    const nextView=JSON.stringify([query,side]);
    if(view!==nextView){view=nextView;limit=4}
    const rows=matchingBitcoinOrders(book,query,side,now());
    const unavailable=!rows.length&&failed&&matchesLiteralSearch('bitcoin btc sats satoshis',query);
    const key=JSON.stringify([view,unavailable,rows.length,...rows.slice(0,limit).map(o=>o.id)]);
    if(key===painted)return rows.length;
    painted=key;root.replaceChildren();root.hidden=!rows.length&&!unavailable;
    clearTimeout(expiry);
    if(rows.length)expiry=setTimeout(changed,Math.min(2147483647,1000*(Math.min(...rows.map(row=>row.quote.expires))-now())+50));
    if(unavailable){
      const retry=element('button','Retry','text-button');retry.type='button';retry.onclick=()=>{stop();onChange()};
      root.append(element('p','Couldn’t load Bitcoin orders.','small muted'),retry);
    }
    if(!rows.length)return 0;
    root.append(element('h3','Bitcoin orders'),element('p',side==='request'?'People buying bitcoin':side==='offer'?'People selling bitcoin':'People buying and selling bitcoin','small muted'));
    const list=element('ul',undefined,'bitcoin-orders-list');
    for(const {quote} of rows.slice(0,limit)){
      const li=element('li'),terms=element('div'),amount=quote.amounts.map(n=>n.toLocaleString(undefined,{maximumFractionDigits:8})).join('–')+' '+quote.currency;
      terms.append(element('strong',amount),element('span',[quote.platform,quote.layer,quote.quantity?quote.quantity.toLocaleString()+' sats':'',quote.premium!==null?'Premium '+quote.premium+'%':'',quote.methods].filter(Boolean).join(' · '),'small muted'));
      li.append(terms);
      if(quote.source){
        const link=element('a','Open '+quote.source.label,'text-button');link.href=quote.source.href;link.target='_blank';link.rel='noopener noreferrer';li.append(link);
      }
      list.append(li);
    }
    root.append(list);
    if(rows.length>limit){
      const more=element('button','Show more orders ('+rows.length+')','text-button');
      more.type='button';more.onclick=()=>{limit+=12;onChange()};root.append(more);
    }
    return rows.length;
  }
  return {update,stop};
}
