export type EscrowOffer={trade:'goods'}|{trade:'bitcoin_fiat';sats:number;method:'bank_transfer'|'cash'};
const fiat=new Set(['EUR','USD','GBP','SEK','NOK','DKK','CHF','CAD','AUD','JPY','CNY','INR']);
export const fiatMethodLabel=(method:'bank_transfer'|'cash')=>method==='cash'?'Cash in person':'Bank transfer';
export function fiatQuoteLabel(price:string,currency:string,locale?:string){
  return new Intl.NumberFormat(locale,{style:'currency',currency,currencyDisplay:'code',minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(price));
}
const MARKER='cashu-2of3-v1';
export const BITCOIN_TAGS=['k','s','amt','f','fa','pm','premium','bond','network','layer','y','z','expires_at'];
export function bitcoinFilter<T extends {kinds:number[]}>(filter:T) {
  return {...filter,kinds:[BITCOIN_KIND],'#y':['iris-market']};
}
export const BITCOIN_KIND=38383;
export function checkEscrowOffer(offer:EscrowOffer,price:string,currency:string,expiry:number){
  if(offer?.trade==='goods' && Object.keys(offer).length===1)return;
  if(!offer || offer.trade!=='bitcoin_fiat' || Object.keys(offer).some(k=>!['trade','sats','method'].includes(k)))throw Error('Unsupported escrow offer.');
  if(!Number.isSafeInteger(offer.sats)||offer.sats<1||offer.sats>1e12)throw Error('Enter a bitcoin amount between 1 and 1 trillion sats.');
  if(typeof currency!=='string'||!fiat.has(currency.toUpperCase())||!/^\d{1,12}(\.\d{1,2})?$/.test(price)||Number(price)<=0)throw Error('Enter a fixed fiat price with up to two decimal places.');
  if(!Number.isSafeInteger(expiry)||expiry<=0||expiry>8.64e12)throw Error('Choose an expiry for this bitcoin offer.');
  if(!['bank_transfer','cash'].includes(offer.method))throw Error('Choose a fiat payment method.');
}
export function offerTags(tags:string[][],offer:EscrowOffer|undefined){
  if(!offer)return {kind:30402,tags};
  if(offer.trade==='goods')checkEscrowOffer(offer,'','',0);
  const next=[...tags,['iris-escrow',MARKER]];
  if(offer.trade==='goods')return {kind:30402,tags:next};
  const val=(k:string)=>tags.find(t=>t[0]===k)?.[1],price=tags.find(t=>t[0]==='price');
  checkEscrowOffer(offer,price?.[1],price?.[2],Number(val('expiration')));
  return {kind:BITCOIN_KIND,tags:[...next.filter(t=>!['market','price','status'].includes(t[0])),['k',val('market')==='offer'?'sell':'buy'],['s','pending'],['amt',String(offer.sats)],['f',price[2].toUpperCase()],['fa',price[1]],['pm',offer.method==='cash'?'cash in person':'bank transfer'],['premium','0'],['bond','0'],['network','mainnet'],['layer','cashu'],['y','iris-market'],['z','order'],['expires_at',val('expiration')]]};
}
export function readEscrowOffer(kind:number,tags:string[][]){
  function val(name:string){const rows=tags.filter(t=>t[0]===name);if(rows.length!==1||rows[0].length!==2)throw Error('Invalid escrow offer');return rows[0][1];}
  if(kind!==BITCOIN_KIND && !tags.some(t=>t[0]==='iris-escrow'))return {};
  if(val('iris-escrow')!==MARKER)throw Error('Unsupported escrow policy');
  if(kind!==BITCOIN_KIND)return {escrow:{trade:'goods'} as EscrowOffer};
  for(const [k,v] of Object.entries({y:'iris-market',z:'order',network:'mainnet',layer:'cashu',premium:'0',bond:'0'}))if(val(k)!==v)throw Error('Unsupported bitcoin offer');
  const method=val('pm'),sats=val('amt'),deadline=val('expires_at'),side=val('k'),status=val('s');
  if(!/^\d+$/.test(sats)||!/^\d+$/.test(deadline)||!['cash in person','bank transfer'].includes(method)||!['buy','sell'].includes(side)||!['pending','canceled','expired','in-progress','success'].includes(status))throw Error('Invalid bitcoin offer');
  const escrow:EscrowOffer={trade:'bitcoin_fiat',sats:Number(sats),method:method==='bank transfer'?'bank_transfer':'cash'};
  const price=val('fa'),currency=val('f'),expiration=Number(deadline);
  checkEscrowOffer(escrow,price,currency,expiration);
  return {escrow,price,currency,expiration,side:side==='buy'?'request':'offer',status:status==='pending'?'active':'sold'};
}
