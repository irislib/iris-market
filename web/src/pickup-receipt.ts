import {getEventHash, verifyEvent, type UnsignedEvent} from 'nostr-tools';
import {isHandoffId, signForHandoffKey, type HandoffKeys} from './order-handoff.ts';
import type {Order} from './orders.ts';

export const PICKUP_ACK = 'iris-market/pickup-ack';
export const PICKUP_RECEIPT = 'iris-market/pickup-receipt';
export type PickupRole = 'collector'|'merchant'|'observer';
export interface PickupProof {
  ref:string; collectedAt:number; collectorSig:string; confirmedAt?:number; merchantSig?:string;
}
export interface PickupContext {ref:string;merchant:string;collector:string;key:string}
export interface PickupView {state:'acknowledged'|'awaiting-confirmation'|'confirmed';collectedAt:number;confirmedAt?:number}
const signature=/^[a-f0-9]{128}$/;
const decimal=(text:string)=>typeof text==='string' && /^(?:0|[1-9][0-9]{0,15})$/.test(text) && Number.isSafeInteger(Number(text));
const validTime=(at:number,now:number)=>at>=now-120 && at<=now+15;
export const pickupActive=(order:Order)=>order.status==='accepted'||order.status==='in-transit';

export function pickupContext(order:Order,owner:string):PickupContext|undefined {
  if(owner!==order.buyer && owner!==order.seller)return;
  const collection=order.deliveryRequest?.collection, assigned=order.pickupAuthorization;
  if(collection && collection.merchant!==order.seller && isHandoffId(collection.reference))
    return {ref:collection.reference,merchant:collection.merchant,collector:order.seller,key:order.seller};
  if(order.fulfillment==='pickup' && order.recipientHandoff)
    return {ref:order.recipientHandoff.id,merchant:order.seller,collector:order.buyer,key:order.recipientHandoff.key};
  if(!order.deliveryRequest && assigned && ![order.buyer,order.seller].includes(assigned.courierPubkey) && isHandoffId(assigned.reference))
    return {ref:assigned.reference,merchant:order.seller,collector:assigned.courierPubkey,key:assigned.courierPubkey};
}
export function pickupRole(order:Order,ctx:PickupContext,owner:string):PickupRole {
  if(owner===ctx.collector)return 'collector';
  if(owner===ctx.merchant && !order.deliveryRequest)return 'merchant';
  return 'observer';
}
const draft=(pubkey:string,at:number,...tags:string[]):UnsignedEvent=>({
  pubkey,kind:27835,created_at:at,content:'',tags:[['iris-market/handoff','2',...tags]]
});
function verify(draft:UnsignedEvent,sig:string){
  const id=getEventHash(draft);
  if(!verifyEvent({...draft,id,sig}))throw Error('The pickup signatures do not match this order.');
  return id;
}
export async function signCollection(ctx:PickupContext,at:number,keys:HandoffKeys):Promise<PickupProof>{
  const event=draft(ctx.key,at,'collect',ctx.ref,ctx.merchant);
  const signed=await signForHandoffKey({id:ctx.ref,key:ctx.key,account:ctx.key===ctx.collector},event,keys);
  verify(event,signed.sig);
  return {ref:ctx.ref,collectedAt:at,collectorSig:signed.sig};
}
export async function signRelease(ctx:PickupContext,proof:PickupProof,at:number,keys:HandoffKeys):Promise<PickupProof>{
  const collectionId=verifyPickup(ctx,proof,at);
  const sign=keys?.accountSigner();
  if(!sign)throw Error('Connect your merchant account signer to confirm pickup.');
  const event=draft(ctx.merchant,at,'release',ctx.ref,collectionId);
  const signed=await sign(event);
  verify(event,signed.sig);
  return {...proof,confirmedAt:at,merchantSig:signed.sig};
}
export function verifyPickup(ctx:PickupContext,proof:PickupProof,now:number){
  const {ref,collectedAt,collectorSig,confirmedAt,merchantSig}=proof;
  if(ref!==ctx.ref)throw Error('This pickup does not match this order.');
  if(!validTime(collectedAt,confirmedAt??now) || collectedAt>now+15 || (confirmedAt!=null && confirmedAt>now+15))
    throw Error('Ask the collector to acknowledge pickup again and check both clocks.');
  const id=verify(draft(ctx.key,collectedAt,'collect',ref,ctx.merchant),collectorSig);
  if(confirmedAt!=null)verify(draft(ctx.merchant,confirmedAt,'release',ref,id),merchantSig);
  return id;
}
export function pickupTag(proof:PickupProof):string[] {
  const part=['1',proof.ref,String(proof.collectedAt),proof.collectorSig];
  return proof.confirmedAt==null ? [PICKUP_ACK,...part] : [PICKUP_RECEIPT,...part,String(proof.confirmedAt),proof.merchantSig];
}
export function readPickupTag(tag:unknown):PickupProof {
  if(!Array.isArray(tag))throw Error('Invalid pickup receipt.');
  const [type,version,ref,collected,sig,confirmed,countersig]=tag;
  const complete=type===PICKUP_RECEIPT;
  if(tag.length!==(complete?7:5) || (!complete && type!==PICKUP_ACK) || version!=='1' || !isHandoffId(ref) ||
     !decimal(collected) || typeof sig!=='string' || sig.length!==128 || !signature.test(sig) ||
     (complete && (!decimal(confirmed) || typeof countersig!=='string' || countersig.length!==128 || !signature.test(countersig))))
    throw Error('Invalid pickup receipt.');
  return {ref,collectedAt:Number(collected),collectorSig:sig,...(complete?{confirmedAt:Number(confirmed),merchantSig:countersig}:{})};
}
export const receiptQR=(proof:PickupProof)=>proof.confirmedAt==null
  ? ['iris-handoff','2','pickup',...pickupTag(proof).slice(2)].join(':')
  : ['iris-pickup-receipt',...pickupTag(proof).slice(1)].join(':');
export function parsePickupQR(qr:string,complete:boolean):PickupProof {
  if(typeof qr!=='string' || qr.length>(complete?384:220))throw Error('Invalid pickup code.');
  const parts=qr.split(':');
  if(complete && parts[0]==='iris-pickup-receipt')return readPickupTag([PICKUP_RECEIPT,...parts.slice(1)]);
  if(!complete && parts[0]==='iris-handoff' && parts[1]==='2' && parts[2]==='pickup')return readPickupTag([PICKUP_ACK,'1',...parts.slice(3)]);
  throw Error('This code does not match this pickup.');
}
