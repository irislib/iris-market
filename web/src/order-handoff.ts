import {schnorr} from '@noble/curves/secp256k1.js';
import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';
import {hexToBytes} from '@noble/hashes/utils.js';
import {finalizeEvent,getEventHash,getPublicKey,verifyEvent,type Event,type UnsignedEvent} from 'nostr-tools';
import type {Order} from './orders.ts';

export type HandoffKind = 'pickup'|'dropoff';
export interface HandoffKey {id:string;key:string}
export interface HandoffAction {kind:HandoffKind;action:'show'|'scan'|'checked'}
export type HandoffSigner = (draft:UnsignedEvent)=>Event|Promise<Event>;
interface Expected extends HandoffKey {kind:HandoffKind;action:'show'|'scan';account?:boolean}
export interface HandoffKeys {deviceSecret:()=>Uint8Array;accountSigner:()=>HandoffSigner|undefined}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const isHandoffId = (id:unknown):id is string => typeof id==='string' && id.length===36 && uuid.test(id);
const info = new TextEncoder().encode('iris-market/order-handoff-key/v1');

export function recipientKey(raw:unknown,buyer:string,seller:string):HandoffKey {
  const value=raw as HandoffKey;
  if(!value || Object.keys(value).length!==2 || !isHandoffId(value.id) || typeof value.key!=='string' || value.key.length!==64 || !/^[a-f0-9]{64}$/.test(value.key))throw Error('Invalid recipient handoff key.');
  if(value.key===buyer || value.key===seller)throw Error('Use a private per-order handoff key.');
  try{schnorr.utils.lift_x(BigInt('0x'+value.key));}catch{throw Error('Invalid recipient handoff key.');}
  return {id:value.id,key:value.key};
}

function withSecret<T>(keys:HandoffKeys,id:string,use:(secret:Uint8Array)=>T):T {
  if(!keys)throw Error('Open the order on the device used at checkout.');
  const secret=hkdf(sha256,keys.deviceSecret(),hexToBytes(id.replaceAll('-','')),info,32);
  try{return use(secret);}finally{secret.fill(0);}
}
export function createRecipientKey(keys:HandoffKeys,id:string=crypto.randomUUID()):HandoffKey {
  return {id,key:withSecret(keys,id,getPublicKey)};
}

// Match only the current party in an accepted order. Route viewers receive no credential.
export function expectedHandoffs(order:Order,owner:string,hasService:boolean):Expected[] {
  if(!['accepted','in-transit'].includes(order.status))return [];
  const {buyer,seller,fulfillment,recipientHandoff:recipient,pickupAuthorization:pickup}=order;
  const collection=order.deliveryRequest?.collection;
  const actions:Expected[]=[];
  if(owner===seller && collection && isHandoffId(collection.reference))
    actions.push({id:collection.reference,key:seller,kind:'pickup',action:'show',account:true});
  if(owner===seller && fulfillment!=='pickup' && !order.deliveryRequest && pickup && isHandoffId(pickup.reference))
    actions.push({id:pickup.reference,key:pickup.courierPubkey,kind:'pickup',action:'scan'});
  if(!recipient)return actions;
  if(fulfillment && owner===buyer)actions.push({...recipient,kind:fulfillment==='pickup'?'pickup':'dropoff',action:'show'});
  if(owner===seller) {
    if(fulfillment==='pickup')actions.push({...recipient,kind:'pickup',action:'scan'});
    else if(collection || (fulfillment==='merchant-delivery' && !hasService && !pickup && !order.shipment.trackingUrl && !order.shipment.stops.some(stop=>stop.courierPubkey)))
      actions.push({...recipient,kind:'dropoff',action:'scan'});
  }
  return actions;
}

export const checkId = (expected:Expected)=>[expected.kind,expected.id,expected.key].join(':');
const draft = ({kind,id,key}:Expected,seconds:number):UnsignedEvent => ({
  pubkey:key,kind:27835,created_at:seconds,content:'',tags:[['iris-market/handoff','1',kind,id]]
});

export async function signHandoff(expected:Expected,seconds:number,keys:HandoffKeys) {
  const event=draft(expected,seconds);
  let signed:Event;
  if(expected.account){
    const signer=keys?.accountSigner();
    if(!signer)throw Error('Connect your courier account signer to show this code.');
    signed=await signer(event);
  }else{
    signed=withSecret(keys,expected.id,secret=>{
      if(getPublicKey(secret)!==expected.key)throw Error('Open the order on the device used at checkout.');
      return finalizeEvent(event,secret);
    });
  }
  return ['iris-handoff','1',expected.kind,expected.id,seconds,signed.sig].join(':');
}

// The QR contributes only its timestamp and signature. Never open it or trust a key supplied by it.
export function verifyHandoff(expected:Expected,qr:string,now:number) {
  const parts=typeof qr==='string' && qr.length<=220 ? qr.split(':') : [];
  const [prefix,version,kind,id,timestamp,sig]=parts;
  if(parts.length!==6 || prefix!=='iris-handoff' || version!=='1' || kind!==expected.kind || id!==expected.id)
    throw Error('This code does not match this handoff.');
  const seconds=Number(timestamp);
  if(!Number.isSafeInteger(seconds) || seconds<0 || String(seconds)!==timestamp || seconds<now-120 || seconds>now+15)
    throw Error('Ask for a fresh handoff code and check the time on both devices.');
  const event=draft(expected,seconds);
  if(sig.length!==128 || !/^[a-f0-9]{128}$/.test(sig) || !verifyEvent({...event,id:getEventHash(event),sig}))
    throw Error('This signature does not match the expected person.');
}
