import {countryCode} from './shipping.ts';

export interface Delivery {countries:string[];price:string}
/** Explicit destinations only: listing location is never a delivery promise. */
export function validateDelivery(value:unknown):Delivery|null|undefined {
  if(value===undefined||value===null)return value as null|undefined;
  const input=value as Delivery;
  if(!Array.isArray(input.countries)||!input.countries.length||input.countries.length>249)throw Error('Choose delivery destinations.');
  const countries=[...new Set(input.countries.map(code=>typeof code==='string'?countryCode(code):null))];
  if(countries.includes(null))throw Error('Choose valid delivery destinations.');
  if(typeof input.price!=='string'||!/^\d+(?:\.\d{1,8})?$/.test(input.price)||input.price.length>24||!Number.isFinite(Number(input.price)))throw Error('Enter a fixed delivery cost, or 0 for free delivery.');
  return {countries:countries.sort(),price:input.price};
}
export function deliveryDraft(value:Delivery,currency:string,{identifier=crypto.randomUUID(),createdAt=Math.floor(Date.now()/1000)}={}) {
  const delivery=validateDelivery(value);
  if(!delivery||!/^[A-Z]{3,12}$/.test(currency))throw Error('Choose a delivery currency.');
  return {kind:30406,created_at:createdAt,content:'',tags:[['d',identifier],['title','Standard delivery'],['price',delivery.price,currency],['country',...delivery.countries],['service','standard']]};
}
