import { getEventHash } from 'nostr-tools';
import type { UnsignedEvent } from 'nostr-tools';
import {courierListingType} from './transport-type.ts';
import {localTestMint} from './wallet/mints.ts';
import type { Vault } from './messaging/vault.ts';
import {PICKUP_ACK,PICKUP_RECEIPT,parsePickupQR,pickupActive,pickupContext,pickupRole,pickupTag,readPickupTag,receiptQR,signCollection,signRelease,verifyPickup,type PickupContext,type PickupProof,type PickupView,type PickupRole} from './pickup-receipt.ts';
import {checkId,createRecipientKey,expectedHandoffs,recipientKey,signHandoff,verifyHandoff,type HandoffAction,type HandoffKey,type HandoffKeys,type HandoffKind} from './order-handoff.ts';

export type OrderStatus='requested'|'accepted'|'in-transit'|'delivered'|'cancelled';
export type StopStatus='pending'|'arrived'|'completed';
export type Coordinates=[number,number];
export interface ShipmentStop {id:string;label:string;address:string;status:StopStatus;coordinates?:Coordinates;courierPubkey?:string}
export interface Shipment {stops:ShipmentStop[];trackingUrl?:string;eta?:number;location?:{coordinates:Coordinates;at:number;courierPubkey:string;stopId:string}}
/** `id` is the replaceable listing address; `eventId` pins the exact signed revision that was ordered. */
/** An order photo is a plain public HTTPS address, as listings publish. */
const orderImage=(url:unknown):url is string=>typeof url==='string'&&url.length<=2048&&url.startsWith('https://')&&!/[\u0000-\u001f\u007f]/.test(url);
/** The most listings one order holds. */
export const MAX_ITEMS=20;
export interface OrderItem {id:string;title:string;price:string;currency:string;quantity:number;eventId?:string;image?:string}
export interface DeliveryPlace {label:string;address:string;coordinates?:Coordinates}
export type Fulfillment='merchant-delivery'|'pickup'|'buyer-courier';
export interface DeliveryRequest {pickup:DeliveryPlace;destination:DeliveryPlace;collection?:{merchant:string;reference:string}}
export interface PickupAuthorization {courierPubkey:string;reference:string}
export interface OrderPayment {mint:string;amount:string;unit:'sat';status:'requested'|'received'}
export interface OrderEscrow {escrowTradeId?:string;escrowProvider?:string}
export interface OrderRequestOptions extends OrderEscrow {quantity?:number;note?:string;deliveryRequest?:DeliveryRequest;fulfillment?:Fulfillment;
  /** Further listings from the same seller, ordered together. */
  basket?:Array<{listing:OrderListing;quantity:number}>}
export interface Order extends OrderEscrow {recipientHandoff?:HandoffKey;payment?:OrderPayment;deliveryRequest?:DeliveryRequest;fulfillment?:Fulfillment;pickupAuthorization?:PickupAuthorization;id:string;buyer:string;seller:string;items:OrderItem[];note:string;status:OrderStatus;createdAt:number;updatedAt:number;shipment:Shipment;routeId:string}
export interface OrderView extends Order {previousPickupReceipts?:{reference:string;collectedAt:number;confirmedAt:number}[];pickupReceiptRole?:PickupRole;pickupReceipt?:PickupView;handoffs:HandoffAction[];sourceOrderId?:string;deliveryOrderId?:string;archived:boolean;role:'buyer'|'seller'|'courier'|null;sync:'queued'|'sent';locationFresh:boolean}
export interface OrderListing {id:string;category?:string;tags?:readonly string[];eventId?:string;imageUrl?:string;author:string;title:string;price:string|number;currency:string;side?:string;status?:string;expiration?:number;escrow?:{trade:string};externalOrder?:unknown}
type CheckoutListing = Pick<OrderListing,'side'|'escrow'|'externalOrder'|'category'|'tags'|'expiration'|'status'>;
export function goodsCheckout(listing:CheckoutListing) {
  const category=listing.category?.trim().toLowerCase();
  return listing.side==='offer' && !listing.externalOrder && category!=='transport' && !courierListingType(listing)
    && (listing.escrow?.trade==='goods' || !['service','services','work','digital'].includes(category??''));
}
export function offersGoodsEscrow(listing:CheckoutListing) {
  return listing.escrow?.trade==='goods' && goodsCheckout(listing) && listing.status!=='sold' && (!listing.expiration || listing.expiration>Date.now()/1000);
}
export type OrderPatch={payment:OrderPayment}|{pickupAuthorization:PickupAuthorization|null}|{status:OrderStatus}|{shipment:Shipment}|{stopId:string;status:StopStatus}|{location:{coordinates:Coordinates;stopId:string}|null};
type EnvelopeBase={v:1;id:string;opId:string;seq:number;at:number;routeId?:string;snapshot?:Order};
export type OrderEnvelope=EnvelopeBase&({action:'request';payload:Order}|{action:'payment';payload:OrderPayment}|{action:'pickup';payload:PickupAuthorization|null}|{action:'status';payload:{status:OrderStatus}}|{action:'route';payload:Shipment}|{action:'stop';payload:{stopId:string;status:StopStatus}}|{action:'location';payload:{stopId:string;coordinates:Coordinates}|null});
type SavedPickup={proof:PickupProof;key:string};
type PickupMatch={record:OrderRecord;ctx:PickupContext};
type OrderRecord={order:Order;terminalAt?:number;pickup?:SavedPickup;pickupHistory?:SavedPickup[];checkedHandoffs?:string[];clocks:Record<string,number>;archived:boolean;sourceOrderId?:string;deliveryOrderId?:string};
type OrderRumor=UnsignedEvent&{id:string};
interface OrderJob {id:string;orderId:string;recipient:string;rumor:OrderRumor;action:OrderEnvelope['action']|'pickup-ack'|'pickup-receipt';at:number;handed:boolean}
interface PendingPickup {proof:PickupProof;sender:string;receivedAt:number}
interface OrderData {pendingPickups?:PendingPickup[];records:OrderRecord[];jobs:OrderJob[];ephemeral:{id:string;orderId:string;opId:string;expiresAt:number}[];blocked:string[];pending:{event:OrderEnvelope;sender:string;senderDevice:string}[]}

export const ORDER_TAG = 'iris-market-order';
export const LOCATION_TTL = 120;
const KEY = 'market/orders/v1', MAX_ORDERS = 256, MAX_JOBS = 512;
const HEX = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const terminal = (order:Order) => ['delivered','cancelled'].includes(order.status);
const fail = (message:string):never => { throw new Error(message); };
const copy = <T>(value:T):T => structuredClone(value);
const time = () => Math.floor(Date.now()/1000);
const text = (value, max, name, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim()) ? value : fail(`Invalid ${name}.`);
const pubkey = value => HEX.test(value || '') ? value : fail('Invalid person.');
const coordinates = (value:unknown):Coordinates => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90 ? [value[0],value[1]] : fail('Invalid map location.');
const statusValues = ['requested','accepted','in-transit','delivered','cancelled'];
const stopValues = ['pending','arrived','completed'];
const recipients = (order:Order):string[] => [...new Set([order.buyer,order.seller,...order.shipment.stops.map(stop=>stop.courierPubkey).filter(Boolean)])];
export const orderRole = (order:Order, owner:string):OrderView['role'] => order.buyer === owner ? 'buyer' : order.seller === owner ? 'seller' : order.shipment.stops.some(stop=>stop.courierPubkey===owner) ? 'courier' : null;

function shipment(raw:unknown = {}):Shipment {
  const value=raw as Partial<Shipment>;
  if (!value || typeof value !== 'object' || !Array.isArray(value.stops) || value.stops.length > 12) fail('Use up to 12 delivery stops.');
  const seen = new Set();
  const stops = value.stops.map(stop => {
    const id = text(stop.id,80,'stop ID'); if(seen.has(id))fail('Stop IDs must be unique.');seen.add(id);
    const status = stop.status ?? 'pending'; if(!stopValues.includes(status))fail('Invalid stop status.');
    return {id,label:text(stop.label??'',120,'stop label',true),address:text(stop.address??'',500,'address',true),status,
      ...(stop.coordinates ? {coordinates:coordinates(stop.coordinates)}:{}),...(stop.courierPubkey ? {courierPubkey:pubkey(stop.courierPubkey)}:{})};
  });
  const result:Shipment = {stops};
  if(value.trackingUrl){const url=new URL(text(value.trackingUrl,2048,'tracking link'));if(url.protocol!=='https:'||url.username||url.password)fail('Use a secure tracking link.');result.trackingUrl=url.href;}
  if(value.eta!==undefined&&value.eta!==null){if(!Number.isSafeInteger(value.eta)||value.eta<0)fail('Invalid delivery time.');result.eta=value.eta;}
  return result;
}
export interface OrderValidationOptions {developerMint?:string}
function validatePayment(raw:unknown,{developerMint}:OrderValidationOptions={}):OrderPayment {
  const value=raw as OrderPayment;if(!value||typeof value!=='object'||value.unit!=='sat'||!['requested','received'].includes(value.status)||typeof value.amount!=='string'||!/^\d+$/.test(value.amount)||value.amount.length>13||BigInt(value.amount)<1n||BigInt(value.amount)>1000000000000n)fail('Invalid payment.');
  const url=new URL(text(value.mint,2048,'mint'));const normalized=url.href.replace(/\/$/,'');
  const permittedLocal=developerMint!==undefined&&localTestMint(developerMint)===normalized;
  if((url.protocol!=='https:'&&!permittedLocal)||url.username||url.password||url.search||url.hash)fail('Use a secure mint URL.');
  return {mint:url.href.replace(/\/$/,''),amount:BigInt(value.amount).toString(),unit:'sat',status:value.status};
}
function deliveryPlace(raw:unknown):DeliveryPlace {
  const value=raw as DeliveryPlace;if(!value||typeof value!=='object')fail('Invalid delivery place.');
  return {label:text(value.label,120,'place label',true),address:text(value.address,500,'address'),...(value.coordinates!==undefined?{coordinates:coordinates(value.coordinates)}:{})};
}
function pickupAuthorization(raw:unknown):PickupAuthorization {
  const value=raw as PickupAuthorization;if(!value||typeof value!=='object')fail('Invalid pickup authorization.');
  return {courierPubkey:pubkey(value.courierPubkey),reference:text(value.reference,80,'collection reference')};
}
export function deliveryOrganizer(order:Pick<Order,'fulfillment'|'buyer'|'seller'>):string|undefined {
  if(order.fulfillment==='pickup')return undefined;
  return order.fulfillment==='merchant-delivery'?order.seller:order.buyer;
}
function deliveryRequest(raw:unknown):DeliveryRequest {
  const value=raw as DeliveryRequest;if(!value||typeof value!=='object')fail('Invalid delivery request.');
  return {pickup:deliveryPlace(value.pickup),destination:deliveryPlace(value.destination),...(value.collection?{collection:{merchant:pubkey(value.collection.merchant),reference:text(value.collection.reference,80,'collection reference')}}:{})};
}
function escrowAttachment(value:OrderEscrow,buyer:string,seller:string):OrderEscrow {
  const {escrowTradeId,escrowProvider}=value;
  if(escrowTradeId==null && escrowProvider==null)return {};
  if(typeof escrowTradeId!=='string' || !HEX.test(escrowTradeId)
    || typeof escrowProvider!=='string' || !HEX.test(escrowProvider)
    || [buyer,seller].includes(escrowProvider)){
    fail('Choose a valid escrow invitation and an independent provider.');
  }
  return {escrowTradeId,escrowProvider};
}
function validateSnapshot(raw:unknown,options:OrderValidationOptions={}):Order {
  const value=raw as Partial<Order>;
  if(!value||typeof value!=='object')fail('Invalid order.');
  const buyer=pubkey(value.buyer),seller=pubkey(value.seller);
  const escrow=escrowAttachment(value,buyer,seller);
  if(escrow.escrowTradeId && value.payment!=null)fail('Use the escrow agreement for this payment.');
  if(buyer===seller||!value.id?.startsWith(`${buyer}:`)||!UUID.test(value.id.slice(65)))fail('Invalid order identity.');
  // One seller per order; a basket can hold several of their listings. Escrow covers a single listing.
  if(!Array.isArray(value.items)||value.items.length<1||value.items.length>MAX_ITEMS)fail(`Order between 1 and ${MAX_ITEMS} listings.`);
  if(escrow.escrowTradeId&&value.items.length!==1)fail('Escrow covers one listing per order.');
  if(new Set(value.items.map(item=>item?.id)).size!==value.items.length)fail('Each listing appears once per order.');
  const items=value.items.map(item=>{
    if(!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>999)fail('Choose a quantity between 1 and 999.');
    const price=String(item.price??'');if(price!==''&&(!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(price)||price.length>24||!Number.isFinite(Number(price))))fail('Invalid price.');
    const currency=String(item.currency??'').toUpperCase();if(!/^[A-Z]{3,12}$/.test(currency))fail('Invalid currency.');
    if(!item.id?.startsWith(`${seller}:`))fail('Listing does not belong to this seller.');
    if(item.eventId!==undefined&&!/^[a-f0-9]{64}$/.test(item.eventId))fail('Invalid listing revision.');
    if(item.image!==undefined&&!orderImage(item.image))fail('Invalid listing photo.');
    return {id:text(item.id,240,'listing ID'),title:text(item.title,160,'listing title'),price,currency,quantity:item.quantity,...(item.eventId?{eventId:item.eventId}:{}),...(item.image?{image:item.image}:{})};
  });
  if(!statusValues.includes(value.status)||!Number.isSafeInteger(value.createdAt)||value.createdAt<0||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<value.createdAt)fail('Invalid order state.');
  if(value.fulfillment!=null && (value.deliveryRequest || !['merchant-delivery','pickup','buyer-courier'].includes(value.fulfillment)))fail('Choose a valid order fulfillment method.');
  if(value.recipientHandoff!==undefined && !value.fulfillment && !value.deliveryRequest?.collection)fail('Recipient handoff requires a goods order or a booked delivery.');
  return {...escrow,...(value.recipientHandoff!==undefined?{recipientHandoff:recipientKey(value.recipientHandoff,buyer,seller)}:{}),...(value.fulfillment?{fulfillment:value.fulfillment}:{}),...(value.payment!==undefined?{payment:validatePayment(value.payment,options)}:{}),...(value.deliveryRequest!==undefined?{deliveryRequest:deliveryRequest(value.deliveryRequest)}:{}),...(value.pickupAuthorization!==undefined?{pickupAuthorization:pickupAuthorization(value.pickupAuthorization)}:{}),id:value.id,buyer,seller,items,note:text(value.note??'',2000,'note',true),status:value.status,createdAt:value.createdAt,updatedAt:value.updatedAt,shipment:shipment(value.shipment),routeId:typeof value.routeId==='string'?text(value.routeId,36,'route ID',true):''};
}
const immutable = (order:Order) => JSON.stringify([order.id,order.buyer,order.seller,order.items,order.note,order.createdAt,order.deliveryRequest,order.escrowTradeId,order.escrowProvider]);
// Older clients must not silently interpret an escrow checkout as direct payment.
function wireVersion(event:OrderEnvelope){
  const linked=event.snapshot?.escrowTradeId!=null || (event.action==='request' && event.payload?.escrowTradeId!=null);
  return linked?'2':'1';
}
export function decodeOrder(rumor:Pick<OrderRumor,'kind'|'tags'>):OrderEnvelope|null {
  if(rumor?.kind!==14||!Array.isArray(rumor.tags))return null;
  const tags=rumor.tags.filter(tag=>tag[0]===ORDER_TAG);
  if(tags.length!==1||tags[0].length!==3||typeof tags[0][2]!=='string'||new TextEncoder().encode(tags[0][2]).length>24000)return null;
  try{const event=JSON.parse(tags[0][2]);if(event.v!==1||!UUID.test(event.opId)||!Number.isSafeInteger(event.seq)||event.seq<1||event.seq>1e9||!Number.isSafeInteger(event.at)||event.at<0||typeof event.id!=='string'||tags[0][1]!==wireVersion(event))return null;return event;}catch{return null;}
}
export const isPickupMessage=(rumor:Pick<OrderRumor,'tags'>)=>rumor?.tags?.some(t=>t[0]===PICKUP_ACK || t[0]===PICKUP_RECEIPT)===true;
export const isOrderMessage = (rumor:Pick<OrderRumor,'tags'>) => rumor?.tags?.some(tag=>tag[0]===ORDER_TAG) === true;
export const orderMessageText = (event:OrderEnvelope, order:Order) => {
  const title=order.items.length>1?`${order.items[0].title} and ${order.items.length-1} more`:order.items[0].title;
  if(event.action==='request')return `Order requested: ${order.items.map(item=>`${item.quantity} × ${item.title}`).join(', ')}${order.note?`\n${order.note}`:''}`;
  if(event.action==='payment')return event.payload.status==='received'?'Payment received (seller confirmation).':'Payment requested.';
  if(event.action==='pickup')return `Pickup authorization updated for ${title}.`;
  if(event.action==='route')return `Delivery details updated for ${title}.`;
  if(event.action==='stop')return `Delivery stop ${event.payload.status} for ${title}.`;
  if(event.action==='location')return event.payload===null?'Location sharing stopped.':'Delivery location shared temporarily.';
  return `Order ${event.payload.status}: ${title}.`;
};

/** Pure role/ordering gate. Only authenticated NDR owner metadata may be sender. */
export function applyOrderEnvelope(previous:OrderRecord|undefined, event:OrderEnvelope, sender:string, owner:string, at = time(), senderDevice = sender, options:OrderValidationOptions={}):{record:OrderRecord;changed:boolean} {
  const policy={developerMint:options.developerMint===undefined?undefined:localTestMint(options.developerMint)};
  const snapshot=(raw:unknown)=>validateSnapshot(raw,policy),payment=(raw:unknown)=>validatePayment(raw,policy);
  pubkey(sender);pubkey(owner);pubkey(senderDevice);
  if(!event||event.v!==1||!UUID.test(event.opId)||!Number.isSafeInteger(event.seq)||event.seq<1||event.seq>1e9||!Number.isSafeInteger(event.at)||event.at<0||event.at>at+300)fail('Invalid order update.');
  let record=previous?copy(previous):null;
  if(!record){
    if(event.action==='request'){
      const order=snapshot(event.payload);
      if(order.id!==event.id||order.buyer!==sender||![order.buyer,order.seller].includes(owner)||order.status!=='requested'||order.shipment.stops.length||order.shipment.trackingUrl||order.routeId||order.pickupAuthorization||order.payment)fail('Invalid order request.');
      record={order,clocks:{},archived:false};
    }else if(event.action==='route'){
      const order=snapshot(event.snapshot);
      if(order.id!==event.id||order.seller!==sender||order.recipientHandoff||[order.buyer,order.seller].includes(owner)||!order.shipment.stops.some(stop=>stop.courierPubkey===owner)||terminal(order)||order.status==='requested')fail('Only the seller can introduce a courier.');
      record={order,clocks:{},archived:false};
    }else fail('Order not found.');
  }
  const order=record.order;
  if(order.createdAt>at+300||order.updatedAt>at+300)fail('Invalid order timestamp.');
  if(order.id!==event.id||!orderRole(order,owner))fail('This order is not shared with you.');
  const clockKey=`${sender}:${senderDevice}`,previousClock=record.clocks[clockKey]??0;
  if(event.seq<=previousClock)return {record,changed:false};
  const role=orderRole(order,sender);
  if(!role)fail('This person cannot update the order.');
  if(previous && ['seller','buyer'].includes(role) && event.snapshot){
    const current=snapshot(event.snapshot);
    if((current.recipientHandoff && (current.recipientHandoff.id!==order.recipientHandoff?.id || current.recipientHandoff.key!==order.recipientHandoff?.key)) || (current.fulfillment && current.fulfillment!==order.fulfillment) || immutable(current)!==immutable(order))fail('Delivery update changed the order.');
    // A later message advances this device's clock past earlier messages. Recover
    // each party's owned fields from its snapshot, never from the other party.
    if(role==='seller'){
      if(current.payment&&order.payment?.status!=='received')order.payment=current.payment;
      if(!terminal(order)){
        if(current.routeId){order.shipment=current.shipment;order.routeId=current.routeId;}
        if(['requested','accepted','in-transit'].includes(current.status)&&statusValues.indexOf(current.status)>statusValues.indexOf(order.status))order.status=current.status;
      }
    }
    if(sender===deliveryOrganizer(order) && ['accepted','in-transit'].includes(order.status) && (!order.fulfillment || current.fulfillment===order.fulfillment)){
      if(current.pickupAuthorization)order.pickupAuthorization=current.pickupAuthorization;
      else delete order.pickupAuthorization;
    }
  }
  if(event.action==='request'){
    if(role!=='buyer'||immutable(snapshot(event.payload))!==immutable(order)||previous)fail('Order request cannot replace an order.');
  }else if(event.action==='payment'){
    if(role!=='seller')fail('Only the seller can update payment.');
    if(order.escrowTradeId)fail('Use the escrow agreement for this payment.');
    const next=payment(event.payload);
    if(order.payment?.status==='received'&&JSON.stringify(order.payment)!==JSON.stringify(next))fail('Received payment cannot change.');
    order.payment=next;
  }else if(event.action==='pickup'){
    if(sender!==deliveryOrganizer(order)||!['accepted','in-transit'].includes(order.status))fail('Only the designated delivery organizer can authorize pickup on an accepted order.');
    if(event.payload && [order.buyer,order.seller].includes(event.payload.courierPubkey))fail('Choose an independent delivery service.');
    if(event.payload===null)delete order.pickupAuthorization;else order.pickupAuthorization=pickupAuthorization(event.payload);
  }else if(event.action==='status'){
    const next=event.payload?.status;
    if(terminal(order)){if(next===order.status)return {record,changed:false};fail('This order is finished.');}
    if(role==='courier')fail('Couriers cannot change the order status.');
    if(next==='cancelled'){}else if(next==='accepted'&&role==='seller'&&['requested','accepted'].includes(order.status)){}
    else if(next==='in-transit'&&role==='seller'&&['accepted','in-transit'].includes(order.status)){}
    else if(next==='delivered'&&(['accepted','in-transit'].includes(order.status)||(role==='seller'&&event.snapshot?.status==='delivered'))){}
    else fail('Invalid order status change.');
    order.status=next;if(terminal(order))delete order.shipment.location;
  }else if(event.action==='route'){
    if(role!=='seller'||terminal(order)||order.status==='requested')fail('Only an accepted order can have delivery details.');
    const source=snapshot(event.snapshot);
    if(immutable(source)!==immutable(order))fail('Delivery update changed the order.');
    order.shipment=shipment(event.payload);order.routeId=event.opId;
  }else if(event.action==='stop'||event.action==='location'){
    if(terminal(order)||!['seller','courier'].includes(role))fail('Only the seller or assigned courier can update delivery.');
    if(event.action==='location'&&event.payload===null){
      if(role==='courier'&&(event.routeId!==order.routeId||(order.shipment.location&&order.shipment.location.courierPubkey!==sender)))fail('You can only stop your own location sharing.');
      delete order.shipment.location;
    }else{
      const stop=order.shipment.stops.find(stop=>stop.id===event.payload?.stopId);
      if(!stop||(role==='courier'&&(stop.courierPubkey!==sender||event.routeId!==order.routeId)))fail('This courier is not assigned to this delivery stop.');
      if(event.action==='stop'){
        const next=event.payload.status;
        if(!stopValues.includes(next)||stopValues.indexOf(next)<stopValues.indexOf(stop.status))fail('Invalid delivery stop change.');
        stop.status=next;if(next==='completed'&&order.shipment.location?.stopId===stop.id)delete order.shipment.location;
      }else{
        if(event.at>at||at-event.at>=LOCATION_TTL)return {record,changed:false};
        if(stop.status==='completed')fail('This delivery stop is complete.');
        order.shipment.location={coordinates:coordinates(event.payload.coordinates),at:event.at,courierPubkey:sender,stopId:stop.id};
      }
    }
  }else fail('Unknown order action.');
  if(!orderRole(order,owner))fail('This order is no longer assigned to you.');
  record.clocks[clockKey]=event.seq;order.updatedAt=Math.max(order.updatedAt,event.at);
  if(terminal(order) && record.terminalAt==null)record.terminalAt=previous && terminal(previous.order)?previous.order.updatedAt:event.at;
  return {record,changed:true};
}

/** Orders and exact outgoing rumors share one atomic encrypted-vault mutation. */
export function createOrderBook({vault,owner,device,handoffKeys,notify=()=>{},now=time,check=()=>{},developerMint}:{handoffKeys?:HandoffKeys;developerMint?:string;vault:Vault;owner:string;device:string;notify?:()=>void;now?:()=>number;check?:()=>void}) {
  const policy={developerMint:developerMint===undefined?undefined:localTestMint(developerMint)};
  const snapshot=(raw:unknown)=>validateSnapshot(raw,policy),payment=(raw:unknown)=>validatePayment(raw,policy);
  let data:OrderData={records:[],jobs:[],ephemeral:[],blocked:[],pending:[]}, writes=Promise.resolve();
  const serial=<T>(operation:()=>Promise<T>):Promise<T>=>{const result=writes.then(()=>{check();return operation();});writes=result.then(()=>{},()=>{});return result;};
  const ownRecipientKeys=new Map<string,string>();
  const checked=new Set<string>();
  const hasDisplayKey=(pass:HandoffKey)=>{
    if(!handoffKeys)return false;
    if(!ownRecipientKeys.has(pass.id))ownRecipientKeys.set(pass.id,createRecipientKey(handoffKeys,pass.id).key);
    return ownRecipientKeys.get(pass.id)===pass.key;
  };
  const persist=async (next:OrderData,receipt?:string)=>{
    check();await vault.put(KEY,next);check();data=next;
    if(receipt)checked.add(receipt);
    notify();
  };
  const available=(record:OrderRecord)=>expectedHandoffs(record.order,owner,!!record.deliveryOrderId);
  const handoffs=(record:OrderRecord):HandoffAction[]=>{
    if(terminal(record.order))return (['pickup','dropoff'] as const)
      .filter(kind=>record.checkedHandoffs?.some(token=>token.startsWith(kind+':')))
      .map(kind=>({kind,action:'checked'}));
    return available(record).flatMap<HandoffAction>(expected=>{
      const {kind,action}=expected,id=checkId(expected);
      if(action==='show' && !(expected.account ? handoffKeys?.accountSigner() : hasDisplayKey(expected)))return [];
      if(action==='scan' && checked.has(id))return record.checkedHandoffs?.includes(id)?[{kind,action:'checked'}]:[];
      return [{kind,action}];
    });
  };
  const expect=(id:string,kind:HandoffKind,action:'show'|'scan')=>{
    const record=data.records.find(row=>row.order.id===id);
    const expected=record&&available(record).find(item=>item.kind===kind && item.action===action);
    if(!expected)fail('This handoff is unavailable for this order.');
    return expected;
  };
  function matchingPickups(next:OrderData,ref:string) {
    const matches=next.records.flatMap(record=>{
      const ctx=pickupContext(record.order,owner);
      return ctx?.ref===ref?[{record,ctx}]:[];
    });
    if(matches.length<=1)return matches;
    // The organizer owns a linked goods order and delivery job. An unrelated order
    // reusing the same random reference cannot claim either receipt.
    if(matches.length===2){
      const [a,b]=matches;
      if(a.ctx.merchant===b.ctx.merchant && a.ctx.collector===b.ctx.collector && a.ctx.key===b.ctx.key &&
         ((a.record.sourceOrderId===b.record.order.id && b.record.deliveryOrderId===a.record.order.id) ||
          (b.record.sourceOrderId===a.record.order.id && a.record.deliveryOrderId===b.record.order.id)))return matches;
    }
    return [];
  }
  function currentPickup(record:OrderRecord,ctx:PickupContext) {
    const saved=record.pickup;
    // Merchant and collector roles are fixed by the original order. Only the
    // random reference and the collector's signing key can change on reassignment.
    return saved?.proof.ref===ctx.ref && saved.key===ctx.key ? saved.proof : undefined;
  }
  function olderPickups(record:OrderRecord,ctx?:PickupContext) {
    const history=record.pickupHistory??[];
    const saved=record.pickup;
    return saved?.proof.confirmedAt!=null && !(ctx && currentPickup(record,ctx)) ? [...history,saved] : history;
  }
  function receiptView(record:OrderRecord):Pick<OrderView,'previousPickupReceipts'|'pickupReceiptRole'|'pickupReceipt'> {
    const ctx=pickupContext(record.order,owner);
    const previous=olderPickups(record,ctx).map(({proof})=>({reference:proof.ref,collectedAt:proof.collectedAt,confirmedAt:proof.confirmedAt}));
    const history=previous.length?{previousPickupReceipts:previous}:{};
    if(!ctx || record.order.status==='requested')return history;
    const proof=currentPickup(record,ctx),role=pickupRole(record.order,ctx,owner);
    return {...history,pickupReceiptRole:role,...(proof?{pickupReceipt:{
      state:proof.confirmedAt!=null?'confirmed':role==='merchant'?'awaiting-confirmation':'acknowledged',
      collectedAt:proof.collectedAt,...(proof.confirmedAt!=null?{confirmedAt:proof.confirmedAt}:{})
    }}:{})};
  }
  function receiptOrder(next:OrderData,id:string,role?:PickupRole,active=false) {
    const record=next.records.find(r=>r.order.id===id);
    const ctx=record && pickupContext(record.order,owner);
    const matches=ctx?matchingPickups(next,ctx.ref):[];
    if(!ctx || (role && pickupRole(record.order,ctx,owner)!==role) || (active && !pickupActive(record.order)) ||
        !matches.some(match=>match.record===record))fail('Pickup receipt unavailable for this order.');
    return {record,ctx,matches};
  }
  function savePickup(next:OrderData,proof:PickupProof,sender:string,selected?:OrderRecord) {
    const matches=matchingPickups(next,proof.ref);
    if(!matches.length)return 'unknown';
    const ctx=matches[0].ctx,complete=proof.confirmedAt!=null;
    if(sender!==(complete?ctx.merchant:ctx.collector))return 'invalid';
    if(complete && matches.every(({record})=>record.order.status==='requested'))return 'waiting';
    if(!matches.some(({record})=>{
      if((selected && record!==selected) || proof.collectedAt<record.order.createdAt-15)return false;
      const role=pickupRole(record.order,ctx,owner);
      return complete ? pickupActive(record.order) || (terminal(record.order) && proof.confirmedAt<=(record.terminalAt??record.order.updatedAt)+15)
        : pickupActive(record.order) && role==='merchant';
    }))return 'invalid';
    verifyPickup(ctx,proof,now());
    return storePickup(matches,proof);
  }
  function storePickup(matches:PickupMatch[],proof:PickupProof) {
    // Check both halves of a linked booking before changing either record.
    for(const {record,ctx} of matches){
      if(record.pickupHistory?.some(saved=>saved.proof.ref===proof.ref))fail('This pickup already has a receipt.');
      if(record.pickup?.proof.confirmedAt!=null && !currentPickup(record,ctx)){
        if(record.pickup.proof.ref===proof.ref)fail('This reference already belongs to a completed pickup.');
        if((record.pickupHistory?.length??0)>=7)fail('This order already has eight pickup receipts.');
      }
    }
    let changed=false;
    for(const {record,ctx} of matches){
      const prior=currentPickup(record,ctx);
      if(prior?.confirmedAt!=null || (proof.confirmedAt==null && prior && prior.collectedAt>=proof.collectedAt))continue;
      if(!prior && record.pickup?.proof.confirmedAt!=null)(record.pickupHistory??=[]).push(record.pickup);
      record.pickup={proof,key:ctx.key};changed=true;
    }
    return changed?'saved':'duplicate';
  }
  function retryPickups(next:OrderData) {
    if(!next.pendingPickups?.length)return;
    next.pendingPickups=next.pendingPickups.filter(({proof,sender,receivedAt})=>{
      if(receivedAt+30*86400<=now())return false;
      try{const result=savePickup(next,proof,sender);return result==='unknown'||result==='waiting';}catch{return false;}
    });
  }
  function enqueuePickup(next:OrderData,record:OrderRecord,proof:PickupProof,peers:string[]) {
    const recipients=[...new Set(peers)].filter(key=>key!==owner),action=proof.confirmedAt==null?'pickup-ack':'pickup-receipt';
    if(next.jobs.length+recipients.length>MAX_JOBS)fail('Too many order updates are waiting to sync.');
    for(const recipient of recipients){
      const unsigned:UnsignedEvent={kind:14,pubkey:device,created_at:proof.confirmedAt??proof.collectedAt,content:'',tags:[['p',recipient],pickupTag(proof),...(proof.confirmedAt==null?[['expiration',String(proof.collectedAt+121)]]:[])]};
      const rumor={...unsigned,id:getEventHash(unsigned)};
      if(!next.jobs.some(job=>job.id===rumor.id))next.jobs.push({id:rumor.id,orderId:record.order.id,recipient,rumor,action,at:unsigned.created_at,handed:false});
    }
  }
  const project=(record:OrderRecord):OrderView=>{const order=copy(record.order);return {...order,...receiptView(record),handoffs:handoffs(record),...(record.sourceOrderId?{sourceOrderId:record.sourceOrderId}:{}),...(record.deliveryOrderId?{deliveryOrderId:record.deliveryOrderId}:{}),archived:record.archived===true,role:orderRole(order,owner),sync:data.jobs.some(job=>job.orderId===order.id)?'queued':'sent',locationFresh:!!order.shipment.location&&now()-order.shipment.location.at>=0&&now()-order.shipment.location.at<LOCATION_TTL};};
  const enqueue=(next:OrderData,record:OrderRecord,event:OrderEnvelope)=>{
    if(event.action==='location')next.jobs=next.jobs.filter(job=>job.orderId!==record.order.id||job.action!=='location');
    const peers=recipients(record.order).filter(peer=>peer!==owner);
    const revoked=next.jobs.filter(job=>job.orderId===record.order.id&&job.action!=='pickup-receipt'&&job.action!=='pickup-ack'&&!peers.includes(job.recipient));
    next.blocked.push(...revoked.map(job=>job.id));
    next.jobs=next.jobs.filter(job=>!revoked.includes(job));
    if(next.blocked.length>4096)fail('The private delivery queue is full.');
    if(next.jobs.length+peers.length>MAX_JOBS)fail('Too many order updates are waiting to sync.');
    const content=orderMessageText(event,record.order);
    for(const peer of peers){
      const shared=copy(event);
      if(shared.snapshot && ![record.order.buyer,record.order.seller].includes(peer)){
        delete shared.snapshot.escrowTradeId;
        delete shared.snapshot.escrowProvider;
        delete shared.snapshot.recipientHandoff;
      }
      const tags=[['p',peer],[ORDER_TAG,wireVersion(shared),JSON.stringify(shared)],['ms',String(event.at*1000)]];
      if(event.action==='location'&&event.payload!==null)tags.push(['expiration',String(event.at+LOCATION_TTL)]);
      const unsigned:UnsignedEvent={kind:14,pubkey:device,created_at:event.at,content,tags},rumor:OrderRumor={...unsigned,id:getEventHash(unsigned)};
      next.jobs.push({id:rumor.id,orderId:record.order.id,recipient:peer,rumor,action:event.action,at:event.at,handed:false});
      if(event.action==='location')next.ephemeral.push({id:rumor.id,orderId:record.order.id,opId:event.opId,expiresAt:event.payload===null?0:event.at+LOCATION_TTL});
    }
    // Only IDs and expiry survive, never prior location coordinates. This ledger
    // suppresses ciphertext still queued inside NDR after a location is replaced.
    if(next.ephemeral.length>4096)fail('The private tracking queue is full.');
    if(terminal(record.order))next.jobs=next.jobs.filter(job=>job.orderId!==record.order.id||job.action!=='location');
  };
  const local=async(orderId:string,action:OrderEnvelope['action'],payload:OrderEnvelope['payload'],initial=false)=>serial(async()=>{
    const next=copy(data),index=next.records.findIndex(record=>record.order.id===orderId),previous=next.records[index];
    if(index===-1&&!initial)fail('Order not found.');
    if(initial && action==='request' && 'escrowTradeId' in payload && payload.escrowTradeId){
      const prior=data.records.find(r=>r.order.buyer===owner && r.order.escrowTradeId===payload.escrowTradeId);
      if(prior){
        const order=prior.order;
        if(order.escrowProvider!==payload.escrowProvider || order.items[0].id!==payload.items[0].id
          || order.items[0].quantity!==payload.items[0].quantity || order.note!==payload.note || order.fulfillment!==payload.fulfillment
          || JSON.stringify(order.deliveryRequest)!==JSON.stringify(payload.deliveryRequest)){
          fail('This escrow invitation already belongs to a different order request.');
        }
        return project(prior);
      }
    }
    const event={v:1,id:orderId,opId:crypto.randomUUID(),seq:(previous?.clocks[`${owner}:${device}`]??0)+1,at:now(),action,payload} as OrderEnvelope;
    if(event.action==='route')event.snapshot={...copy(previous.order),shipment:event.payload,routeId:event.opId};
    if(action==='stop'||action==='location')event.routeId=previous.order.routeId;
    const {record}=applyOrderEnvelope(previous,event,owner,owner,now(),device,policy);
    if([record.order.buyer,record.order.seller].includes(owner)&&action!=='location')event.snapshot=snapshot(record.order);
    if(index===-1){if(next.records.length>=MAX_ORDERS)fail('The local order limit has been reached.');next.records.push(record);}else next.records[index]=record;
    enqueue(next,record,event);retryPickups(next);await persist(next);return project(record);
  });
  return {
    pickupPeers:()=>new Set(data.records.flatMap(({order})=>{
      if(!pickupActive(order))return [];
      const ctx=pickupContext(order,owner);if(!ctx)return [];
      const role=pickupRole(order,ctx,owner);
      return role==='merchant'?[ctx.collector]:role==='collector'?[ctx.merchant]:[];
    })),
    state:()=>data.records.map(project).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)),
    async load(){
      const stored=await vault.get<OrderData>(KEY);check();if(!stored)return;
      if(!Array.isArray(stored.records)||stored.records.length>MAX_ORDERS||!Array.isArray(stored.jobs)||stored.jobs.length>MAX_JOBS||!Array.isArray(stored.ephemeral))fail('Invalid private order storage.');
      data={...stored,blocked:stored.blocked??[],pending:stored.pending??[]};
      checked.clear();
      for(const record of data.records)for(const id of record.checkedHandoffs??[])checked.add(id);
    },
    flush:()=>writes,
    request(listing:OrderListing,{quantity=1,note='',deliveryRequest:delivery,fulfillment,basket,...selected}:OrderRequestOptions={}){
      if(!listing||listing.side==='request'||listing.status==='sold'||listing.expiration&&listing.expiration<=now())fail('Choose an available selling listing.');
      const escrow=escrowAttachment(selected,owner,listing.author);
      if(fulfillment && (!goodsCheckout(listing) || basket?.some(item=>!goodsCheckout(item.listing))))fail('Delivery choices are available for physical goods.');
      if(escrow.escrowTradeId && (listing.externalOrder || listing.escrow?.trade!=='goods'))fail('This listing does not offer escrow for orders.');
      const item=(value:OrderListing,count:number)=>({id:value.id,title:value.title,price:value.price,currency:value.currency,quantity:count,...(/^[a-f0-9]{64}$/.test(value.eventId??'')?{eventId:value.eventId}:{}),...(orderImage(value.imageUrl)?{image:value.imageUrl}:{})});
      for(const extra of basket??[])if(!extra?.listing||extra.listing.author!==listing.author||extra.listing.side==='request'||extra.listing.status==='sold'||extra.listing.expiration&&extra.listing.expiration<=now())fail('A basket item is no longer available from this seller.');
      const order=snapshot({...escrow,fulfillment,...(fulfillment?{recipientHandoff:createRecipientKey(handoffKeys)}:{}),id:`${owner}:${crypto.randomUUID()}`,buyer:owner,seller:listing.author,items:[item(listing,quantity),...(basket??[]).map(extra=>item(extra.listing,extra.quantity))],...(delivery?{deliveryRequest:delivery}:{}),note,status:'requested',createdAt:now(),updatedAt:now(),shipment:{stops:[]},routeId:''});
      return local(order.id,'request',order,true);
    },
    requestDelivery(sourceOrderId:string,serviceListing:OrderListing,destination:DeliveryPlace,merchantPickup?:DeliveryPlace){return serial(async()=>{
      const next=copy(data),source=next.records.find(record=>record.order.id===sourceOrderId);
      if(!source||deliveryOrganizer(source.order)!==owner||!['accepted','in-transit'].includes(source.order.status))fail('Choose your accepted product order.');
      if(source.deliveryOrderId||source.order.pickupAuthorization)fail('Delivery has already been requested.');
      if(source.order.deliveryRequest||source.order.shipment.stops.some(stop=>stop.courierPubkey))fail('Choose a product pickup shared only with its merchant.');
      if(merchantPickup && owner!==source.order.seller)fail('Use the pickup place provided by the merchant.');
      const pickup=owner===source.order.seller?merchantPickup:source.order.shipment.stops[0];if(!pickup)fail('Provide a pickup place first.');
      const listing=serviceListing;if(!listing||listing.side!=='offer'||listing.status==='sold'||listing.expiration&&listing.expiration<=now()||[source.order.seller,source.order.buyer].includes(listing.author)||!['parcel','both'].includes(courierListingType(listing)??''))fail('Choose an available separate parcel delivery service.');
      if(next.records.length>=MAX_ORDERS)fail('The local order limit has been reached.');
      const at=now(),reference=crypto.randomUUID(),id=`${owner}:${crypto.randomUUID()}`;
      const order=snapshot({id,...(source.order.recipientHandoff?{recipientHandoff:source.order.recipientHandoff}:{}),buyer:owner,seller:listing.author,items:[{id:listing.id,title:listing.title,price:listing.price,currency:listing.currency,quantity:1,...(/^[a-f0-9]{64}$/.test(listing.eventId??'')?{eventId:listing.eventId}:{}),...(orderImage(listing.imageUrl)?{image:listing.imageUrl}:{})}],note:'',status:'requested',createdAt:at,updatedAt:at,shipment:{stops:[]},routeId:'',deliveryRequest:{pickup:deliveryPlace(pickup),destination:deliveryPlace(destination),collection:{merchant:source.order.seller,reference}}});
      const request:OrderEnvelope={v:1,id,opId:crypto.randomUUID(),seq:1,at,action:'request',payload:order};
      const delivery=applyOrderEnvelope(undefined,request,owner,owner,at,device,policy).record;
      const authorization:OrderEnvelope={v:1,id:sourceOrderId,opId:crypto.randomUUID(),seq:(source.clocks[`${owner}:${device}`]??0)+1,at,action:'pickup',payload:{courierPubkey:listing.author,reference}};
      const updated=applyOrderEnvelope(source,authorization,owner,owner,at,device,policy).record;
      updated.deliveryOrderId=id;delivery.sourceOrderId=sourceOrderId;
      next.records[next.records.indexOf(source)]=updated;next.records.push(delivery);
      authorization.snapshot=snapshot(updated.order);request.snapshot=snapshot(delivery.order);
      enqueue(next,updated,authorization);enqueue(next,delivery,request);retryPickups(next);await persist(next);return project(delivery);
    });},
    acknowledgeOrderPickup(id:string){return serial(async()=>{
      const next=copy(data),{record,ctx,matches}=receiptOrder(next,id,'collector',true),prior=currentPickup(record,ctx);
      if(prior?.confirmedAt!=null)fail('Pickup already confirmed.');
      if(prior?.collectedAt>=now()-120)return receiptQR(prior);
      const proof=await signCollection(ctx,now(),handoffKeys);
      storePickup(matches,proof);enqueuePickup(next,record,proof,[ctx.merchant]);await persist(next);
      return receiptQR(proof);
    });},
    confirmOrderPickup(id:string){return serial(async()=>{
      const next=copy(data),{record,ctx,matches}=receiptOrder(next,id,'merchant',true),partial=currentPickup(record,ctx);
      if(!partial)fail('Wait for the collector to acknowledge pickup.');
      if(partial.confirmedAt!=null)return project(record);
      const complete=await signRelease(ctx,partial,now(),handoffKeys);
      storePickup(matches,complete);enqueuePickup(next,record,complete,[ctx.collector,record.order.buyer]);await persist(next);
      return project(record);
    });},
    showPickupReceipt(id:string,reference?:string){
      check();const record=data.records.find(row=>row.order.id===id);
      if(!record)fail('Order not found.');
      const ctx=pickupContext(record.order,owner),history=olderPickups(record,ctx);
      let saved=ctx && currentPickup(record,ctx)?.confirmedAt!=null ? record.pickup : undefined;
      if(reference && reference!==saved?.proof.ref)saved=history.find(row=>row.proof.ref===reference);
      if(!reference && !ctx && history.length===1)saved=history[0];
      if(!saved)fail('Pickup has not been confirmed.');
      return receiptQR(saved.proof);
    },
    verifyPickupReceipt(id:string,qr:string){return serial(async()=>{
      const next=copy(data),record=next.records.find(row=>row.order.id===id);
      if(!record)fail('Order not found.');
      const proof=parsePickupQR(qr,true);
      if(olderPickups(record,pickupContext(record.order,owner)).some(saved=>receiptQR(saved.proof)===qr))return project(record);
      const {ctx}=receiptOrder(next,id);
      if(proof.ref!==ctx.ref || record.order.status==='requested' || pickupRole(record.order,ctx,owner)==='merchant')fail('This receipt does not match this order.');
      const result=savePickup(next,proof,ctx.merchant,record);
      if(result==='saved')await persist(next);
      else if(result!=='duplicate')fail('This receipt does not match this order.');
      return project(record);
    });},
    receivePickup(rumor:OrderRumor,sender:string){return serial(async()=>{
      if(rumor?.kind!==14 || rumor.content!=='' || !HEX.test(sender||'') || !Array.isArray(rumor.tags))return;
      const tags=rumor.tags.filter(t=>t[0]===PICKUP_ACK || t[0]===PICKUP_RECEIPT),peers=rumor.tags.filter(t=>t[0]==='p');
      if(tags.length!==1 || peers.length!==1 || (peers[0][1]!==owner && sender!==owner))return;
      let proof:PickupProof,outcome:string;
      const next=copy(data);
      try{proof=readPickupTag(tags[0]);outcome=savePickup(next,proof,sender);}catch{return;}
      if(outcome==='saved'){await persist(next);return;}
      if(proof.confirmedAt==null || proof.confirmedAt>now()+15 || proof.collectedAt<proof.confirmedAt-120 || proof.collectedAt>proof.confirmedAt+15)return;
      const known=next.records.filter(({order})=>pickupContext(order,owner)?.ref===proof.ref);
      if(known.length){
        if(!known.some(({order})=>order.status==='requested' && pickupContext(order,owner).merchant===sender))return;
        try{verifyPickup(pickupContext(known[0].order,owner),proof,now());}catch{return;}
      }else if(!next.records.some(({order})=>order.seller===sender || order.deliveryRequest?.collection?.merchant===sender))return;
      const pending=(next.pendingPickups??[]).filter(row=>row.receivedAt+30*86400>now());
      if(pending.length>=64 || pending.filter(row=>row.sender===sender).length>=8 ||
         pending.some(row=>row.sender===sender && row.proof.merchantSig===proof.merchantSig))return;
      pending.push({sender,proof,receivedAt:now()});next.pendingPickups=pending;await persist(next);
    });},
    async showHandoff(id:string,kind:HandoffKind){
      check();
      const expected=expect(id,kind,'show');
      const qr=await signHandoff(expected,now(),handoffKeys);
      check();
      if(checkId(expect(id,kind,'show'))!==checkId(expected))fail('The handoff has changed.');
      verifyHandoff(expected,qr,now());
      return qr;
    },
    checkHandoff(id:string,kind:HandoffKind,qr:string){return serial(async()=>{
      if(kind==='pickup' && typeof qr==='string' && qr.startsWith('iris-handoff:2:')){
        const next=copy(data),{ctx,record}=receiptOrder(next,id,'merchant',true);
        const proof=parsePickupQR(qr,false);
        if(proof.ref!==ctx.ref)fail('This code does not match this pickup.');
        const result=savePickup(next,proof,ctx.collector,record);
        if(result==='saved')await persist(next);
        else if(result!=='duplicate')fail('This code does not match this pickup.');
        return;
      }
      const expected=expect(id,kind,'scan'),token=checkId(expected);
      if(checked.has(token))fail('This handoff was already checked on this device.');
      verifyHandoff(expected,qr,now());
      const next=copy(data),record=next.records.find(row=>row.order.id===id);
      if((record.checkedHandoffs?.length??0)>=32)fail('The handoff check limit for this order has been reached.');
      (record.checkedHandoffs??=[]).push(token);
      await persist(next,token);
    });},
    update(id:string,patch:OrderPatch){
      if(!patch||typeof patch!=='object')fail('Choose an order update.');
      if('payment' in patch)return local(id,'payment',payment(patch.payment));
      if('pickupAuthorization' in patch)return local(id,'pickup',patch.pickupAuthorization===null?null:pickupAuthorization(patch.pickupAuthorization));
      if('location' in patch)return local(id,'location',patch.location===null?null:{stopId:text(patch.location.stopId,80,'stop ID'),coordinates:coordinates(patch.location.coordinates)});
      if('stopId' in patch)return local(id,'stop',{stopId:text(patch.stopId,80,'stop ID'),status:patch.status});
      if('shipment' in patch)return local(id,'route',shipment(patch.shipment));
      if('status' in patch)return local(id,'status',{status:patch.status});
      fail('Choose an order update.');
    },
    archive(id,archived){return serial(async()=>{const next=copy(data),record=next.records.find(item=>item.order.id===id);if(!record)fail('Order not found.');record.archived=!!archived;await persist(next);return project(record);});},
    receive(rumor:OrderRumor,sender:string,senderDevice:string){return serial(async()=>{
      const event=decodeOrder(rumor);if(!event||!HEX.test(sender||'')||!HEX.test(senderDevice||''))return null;
      const next=copy(data),index=next.records.findIndex(record=>record.order.id===event.id);
      let applied;try{applied=applyOrderEnvelope(next.records[index],event,sender,owner,now(),senderDevice,policy);}catch{
        // A sibling's original request can arrive after the seller's reply.
        // Hold at most 64 authenticated party updates, never courier claims or
        // positions, and expose nothing until the buyer's request is present.
        if(index===-1&&event.action!=='request'&&event.action!=='location'&&event.at<=now()+300){
          try{
            const claimed=snapshot(event.snapshot);
            if(claimed.id!==event.id||!((sender===claimed.seller&&owner===claimed.buyer)||(sender===claimed.buyer&&owner===claimed.seller&&event.action==='status'&&event.payload?.status==='cancelled')))return null;
            if(next.pending.length>=64||next.pending.some(item=>item.event.opId===event.opId))return null;
          }catch{return null; /* Invalid snapshots never become pending orders. */}
          // A storage failure must reach the durable NDR handler for retry.
          next.pending.push({event,sender,senderDevice});await persist(next);
        }
        return null;
      }
      if(!applied.changed)return null;
      if(index===-1){if(next.records.length>=MAX_ORDERS)return null;next.records.push(applied.record);}else next.records[index]=applied.record;
      for(const pending of next.pending.filter(item=>item.event.id===event.id).sort((a,b)=>a.event.at-b.event.at||a.event.seq-b.event.seq||a.event.opId.localeCompare(b.event.opId))){
        try{applied=applyOrderEnvelope(applied.record,pending.event,pending.sender,owner,now(),pending.senderDevice,policy);}catch{/* An authenticated stale or invalid action is consumed. */}
      }
      next.pending=next.pending.filter(item=>item.event.id!==event.id);
      next.records[next.records.findIndex(record=>record.order.id===event.id)]=applied.record;
      if(terminal(applied.record.order))next.jobs=next.jobs.filter(job=>job.orderId!==event.id||job.action!=='location');
      retryPickups(next);await persist(next);return {orderId:event.id,location:event.action==='location'};
    });},
    jobs:()=>copy(data.jobs.filter(publishableJob)),
    async prune(){return serial(async()=>{const next=copy(data);next.jobs=next.jobs.filter(publishableJob);if(next.jobs.length!==data.jobs.length)await persist(next);});},
    handed(id){return serial(async()=>{const next=copy(data),job=next.jobs.find(job=>job.id===id);if(job){job.handed=true;await persist(next);}});},
    sent(id,recipient){return serial(async()=>{const job=data.jobs.find(job=>job.id===id);if(!job||job.recipient!==recipient)return;const next=copy(data);next.jobs=next.jobs.filter(job=>job.id!==id);await persist(next);});},
    canPublish,
  };
  function publishableJob(job:OrderJob){
    if(job.action==='pickup-ack')return job.at+121>now();
    return job.action!=='location' || canPublish(job.id);
  }
  function canPublish(id){
    if(data.blocked.includes(id))return false;
    const item=data.ephemeral.find(item=>item.id===id);if(!item)return true;
    const record=data.records.find(record=>record.order.id===item.orderId);
    const latest=data.ephemeral.filter(other=>other.orderId===item.orderId).at(-1);
    return !!record&&!terminal(record.order)&&latest?.opId===item.opId&&(!item.expiresAt||now()<item.expiresAt);
  }
}
