import type {Event, Filter} from 'nostr-tools';
import {BITCOIN_KIND} from './escrow-offer.ts';
import {spaceSellers} from './seller-spacing.ts';
import {matchesLiteralSearch} from './lexical-search.ts';

export const BITCOIN_ORDER_RELAY='wss://relay.mostro.network';
// Include recent revisions of every status so a cancellation can replace a pending order.
export const orderFilters:Filter[]=[
  ...['buy','sell'].map(side=>({kinds:[BITCOIN_KIND],'#z':['order'],'#s':['pending'],'#k':[side],limit:120})),
  {kinds:[BITCOIN_KIND],'#z':['order'],limit:120},
];

function orderSource(raw:string|undefined,event:Event,id:string) {
  if(!raw||raw.length>2048)return;
  try {
    const url=new URL(raw);
    if(url.protocol==='https:'&&!url.username&&!url.password)return {href:url.href,label:url.hostname};
    if(url.protocol==='mostro:'&&url.pathname===id&&/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)&&
      url.searchParams.getAll('mostro').length===1&&url.searchParams.get('mostro')===event.pubkey)
      return {href:url.href,label:'Mostro'};
  }catch{/* An optional source must be safe to open. */}
}

// The public runtime authenticates the event before it reaches the order book.
// Keep a closed or unrenderable winning revision even if it has dropped its quote.
export function readBitcoinOrder(event:Event) {
  if(event.kind!==BITCOIN_KIND)return;
  const field=(key:string)=>{const rows=event.tags.filter(t=>t[0]===key);return rows.length===1?rows[0].slice(1):[]};
  const id=field('d')[0];
  if(!id||id.length>160||field('z')[0]!=='order')return;
  const revision={key:event.pubkey+':'+id,id:event.id,created:event.created_at,author:event.pubkey};
  const platform=field('y')[0],side=field('k')[0],amounts=field('fa'),currency=field('f')[0];
  const deadlines=['expiration','expires_at'].filter(k=>event.tags.some(tag=>tag[0]===k)).map(k=>Number(field(k)[0]));
  const expires=Math.min(...deadlines);
  if(!platform||platform.length>100||platform==='iris-market'||field('s')[0]!=='pending'||field('network')[0]!=='mainnet'||
    !['buy','sell'].includes(side)||!Number.isSafeInteger(expires)||expires<=0||!/^[A-Z]{3}$/.test(currency??'')||
    !amounts.length||amounts.length>2||amounts.some(n=>!/^\d{1,15}(\.\d{1,8})?$/.test(n)||Number(n)<=0)||
    (amounts.length===2&&Number(amounts[1])<Number(amounts[0])))return {...revision,quote:null};
  const methods=field('pm').join(' · ').slice(0,300),layer=(field('layer')[0]||'').slice(0,40);
  const sats=field('amt')[0],quantity=/^\d{1,15}$/.test(sats??'')&&Number(sats)>0?Number(sats):null;
  const rate=field('premium')[0];
  const premium=/^[+-]?\d{1,4}(\.\d{1,4})?$/.test(rate??'')?Number(rate):null;
  const source=orderSource(field('source')[0],event,id);
  const search=['bitcoin btc sats satoshis',side==='buy'?'buy buying':'sell selling',platform,layer,currency,methods,...amounts].join(' ');
  return {...revision,quote:{side,platform,amounts:amounts.map(Number),currency,methods,layer,quantity,premium,expires,source,search}};
}
type Order=NonNullable<ReturnType<typeof readBitcoinOrder>>;
export function mergeBitcoinOrders(book:Map<string,Order>,events:readonly Event[],now:number) {
  let changed=false;
  for(const event of events){
    if(!Number.isSafeInteger(event.created_at)||event.created_at<0||event.created_at>now+300)continue;
    const next=readBitcoinOrder(event);if(!next)continue;
    const old=book.get(next.key);
    if(old?(next.created>old.created||next.created===old.created&&next.id<old.id):book.size<4000){
      book.set(next.key,next);changed=true;
    }
  }
  return changed;
}
export function matchingBitcoinOrders(book:Map<string,Order>,query:string,side:string,now:number) {
  const ranked=[...book.values()].filter(o=>o.quote&&o.quote.expires>now&&
    (side==='all'||o.quote.side===(side==='request'?'buy':'sell'))&&matchesLiteralSearch(o.quote.search,query))
    .sort((a,b)=>b.created-a.created||a.id.localeCompare(b.id));
  return spaceSellers(ranked);
}
