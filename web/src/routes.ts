import { decode, npubEncode, naddrEncode } from 'nostr-tools/nip19';
import { routeBase } from './route-base.ts';

export type MarketRoute = {type:'home'|'saved'|'post'|'wallet'|'settings'|'account'|'courier'|'missing'} | {type:'search';query:string} | {type:'profile';pubkey:string} | {type:'listing';id:string} | {type:'messages';pubkey?:string} | {type:'orders';id?:string};
const keyPattern = /^[a-f0-9]{64}$/;
export function validListingId(id: string): boolean { if(typeof id==='string' && id.startsWith('38383:'))id=id.slice(6); return typeof id === 'string' && keyPattern.test(id.slice(0,64)) && id[64] === ':' && new TextEncoder().encode(id.slice(65)).length > 0 && new TextEncoder().encode(id.slice(65)).length <= 160; }
function publicKey(value: string): string | null {
  try { if(keyPattern.test(value))return value;const parsed=decode(value);return parsed.type==='npub'?parsed.data:parsed.type==='nprofile'?parsed.data.pubkey:null; }catch{return null;}
}
export function parseMarketRoute(href: string): MarketRoute {
  const url=new URL(href),base=routeBase(href);
  if(url.searchParams.has('profile')){const pubkey=publicKey(url.searchParams.get('profile'));return pubkey?{type:'profile',pubkey}:{type:'missing'};}
  if(url.searchParams.has('listing')){const id=url.searchParams.get('listing');return validListingId(id)?{type:'listing',id}:{type:'missing'};}
  const queryPage=url.searchParams.get('page');
  const raw=queryPage?queryPage.split('/'):url.pathname.slice(base.pathname.length).split('/').filter(Boolean);
  let parts:string[];try{parts=raw.map(decodeURIComponent);}catch{return {type:'missing'};}
  if(!parts.length||parts[0]==='index.html')return {type:'home'};
  if(parts.length===1&&parts[0]==='search'){const query=(url.searchParams.get('q')||'').trim().slice(0,300);return query?{type:'search',query}:{type:'home'};}
  if(parts.length===2&&parts[0]==='settings'&&parts[1]==='profile')return {type:'account'};
  if(parts.length===1&&['saved','post','wallet','settings','courier'].includes(parts[0]))return {type:parts[0] as 'saved'|'post'|'wallet'|'settings'|'courier'};
  if(parts[0]==='messages'&&parts.length<=2){const pubkey=parts[1]?publicKey(parts[1]):undefined;return parts[1]&&!pubkey?{type:'missing'}:{type:'messages',...(pubkey?{pubkey}:{})};}
  if(parts[0]==='orders'&&parts.length<=2)return parts[1]&&parts[1].length>160?{type:'missing'}:{type:'orders',...(parts[1]?{id:parts[1]}:{})};
  if(parts.length===1&&parts[0].startsWith('naddr1')){try{const event=decode(parts[0]);if(event.type==='naddr'&&[30402,38383].includes(event.data.kind)){const id=(event.data.kind===38383?'38383:':'')+`${event.data.pubkey}:${event.data.identifier}`;if(validListingId(id))return {type:'listing',id};}}catch{}return {type:'missing'};}
  const pubkey=publicKey(parts[0]);
  if(pubkey&&parts.length===1)return {type:'profile',pubkey};
  if(pubkey&&parts.length===2){const id=`${pubkey}:${parts[1]}`;if(validListingId(id))return {type:'listing',id};}
  return {type:'missing'};
}
export function pageURL(page: string, href = location.href): string {
  const base=routeBase(href);
  if(page) { if(base.pathname==='/')base.pathname+=page;else base.searchParams.set('page',page); }
  return base.href;
}
export function searchURL(query:string,href=location.href):string {
  const value=query.trim().slice(0,300);const url=new URL(pageURL(value?'search':'',href));
  if(value)url.searchParams.set('q',value);
  return url.href;
}
export function profileURL(pubkey: string, href = location.href): string {
  if(!keyPattern.test(pubkey))throw new Error('Invalid profile');
  const base=routeBase(href),npub=npubEncode(pubkey);
  if(base.pathname==='/')base.pathname+=npub;else base.searchParams.set('profile',npub);
  return base.href;
}
export function listingURL(id: string, href = location.href): string {
  if(!validListingId(id))throw new Error('Invalid listing');
  const base=routeBase(href);
  if(base.pathname==='/')base.pathname+=id.startsWith('38383:')||['.','..'].includes(id.slice(65))?listingAddress(id):`${npubEncode(id.slice(0,64))}/${encodeURIComponent(id.slice(65))}`;else base.searchParams.set('listing',id);
  return base.href;
}
export function listingAddress(id: string): string {
  if(!validListingId(id))throw new Error('Invalid listing');
  const kind=id.startsWith('38383:')?38383:30402;if(kind===38383)id=id.slice(6);
  return naddrEncode({kind,pubkey:id.slice(0,64),identifier:id.slice(65)});
}
