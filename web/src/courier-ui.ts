import {flushSync,mount,unmount} from 'svelte';
import {element} from './dom.ts';
import type {OrderView} from './orders.ts';
import {validateServiceArea} from './service-area.ts';
import Workspace from './courier/Workspace.svelte';
import {CourierWorkspaceState,type CourierWorkspaceOptions} from './courier/state.svelte.ts';
import type {ServiceAreas} from './service-area.ts';

import {courierListingType} from './transport-type.ts';
import type {CourierType} from './transport-type.ts';
export {courierListingType} from './transport-type.ts';
export type {CourierType} from './transport-type.ts';
export interface CourierListing {
  id:string; author:string; title:string; side:string; category?:string; tags?:readonly string[];
  location?:string; price?:string|number; currency?:string; status?:string; expiration?:number|null; createdAt?:number; serviceAreas?:ServiceAreas|null;
}
export interface CourierServiceDraft {
  side:'offer'; category:'transport'; title:string; description:string; location:string; price:''; tags:string[]; serviceAreas:ServiceAreas;
}
export interface CourierFeedOptions {
  getListings:()=>readonly CourierListing[];
  onListing:(listing:CourierListing)=>void;
  onAnnounce:(draft:CourierServiceDraft)=>void;
  onEditListing?:(listing:CourierListing)=>void;
  renderListing?:(listing:CourierListing)=>HTMLElement;
  loadMore?:()=>Promise<unknown>;
  pagination?:()=>{hasMore?:boolean;loading?:boolean;error?:string};
}
const clean=(value:string)=>value.normalize('NFKC').trim().toLowerCase();
const terminal=(order:Pick<OrderView,'status'>)=>['delivered','cancelled'].includes(order.status);
const validType=(value:unknown):value is CourierType=>typeof value==='string'&&['parcel','passenger','both'].includes(value);

export function courierListings(listings:readonly CourierListing[], {type='parcel',area='',side='request',owner,now=Math.floor(Date.now()/1000)}:{type?:CourierType;area?:string;side?:'request'|'offer';owner?:string;now?:number}={}):CourierListing[] {
  const place=clean(area),seen=new Set<string>();
  return listings.slice(0,1000).filter(listing=>{
    if(seen.has(listing.id))return false;seen.add(listing.id);
    const kind=courierListingType(listing);
    return listing.side===side&&listing.status==='active'&&(listing.expiration==null||listing.expiration>now)
      &&(side==='offer'?!!owner&&listing.author===owner:listing.author!==owner)
      &&!!kind&&(type==='both'||kind==='both'||kind===type)&&(!place||clean(listing.location??'').includes(place));
  }).sort((a,b)=>(b.createdAt??0)-(a.createdAt??0)||a.id.localeCompare(b.id));
}
export function courierServiceDraft(type:CourierType, area:string,serviceAreas?:ServiceAreas):CourierServiceDraft {
  const location=area.trim();
  if(!validType(type)||Array.from(location).length>160||/[\u0000-\u001f\u007f]/.test(location))throw new Error('Enter a valid area name.');
  if(!serviceAreas?.pickup)throw new Error('Choose a pickup area.');
  if(!serviceAreas.destination)throw new Error('Choose a destination area.');
  const checked={pickup:validateServiceArea(serviceAreas.pickup),destination:validateServiceArea(serviceAreas.destination)};
  const title=type==='parcel'?'Deliveries':type==='passenger'?'Rides':'Deliveries and rides';
  return {side:'offer',category:'transport',title,description:`${title}${location?` in ${location}`:''}.`,location,price:'',tags:['courier',...(type!=='passenger'?['parcel']:[]),...(type!=='parcel'?['passenger']:[])],serviceAreas:checked};
}
export function courierJobs(orders:readonly OrderView[], owner?:string):OrderView[] {
  if(!owner)return[];
  return orders.filter(order=>!order.archived&&order.shipment.stops.some(stop=>stop.courierPubkey===owner||order.seller===owner))
    .sort((a,b)=>Number(terminal(a))-Number(terminal(b))||b.updatedAt-a.updatedAt);
}
/** Profile reviews remain general public reviews, with no order or private route attached. */
export function orderReviewParticipants(order:OrderView,owner?:string):Array<{pubkey:string;label:string}> {
  if(!owner||order.status!=='delivered')return[];
  const people=[{pubkey:order.buyer,label:'Customer'},{pubkey:order.seller,label:'Seller'},...order.shipment.stops.filter(stop=>stop.courierPubkey).map(stop=>({pubkey:stop.courierPubkey!,label:'Courier'}))];
  if(!people.some(person=>person.pubkey===owner))return[];
  const seen=new Set([owner]);return people.filter(person=>{if(seen.has(person.pubkey))return false;seen.add(person.pubkey);return true;});
}

/** A view of existing public listings and private jobs; opening it never announces availability or starts GPS. */
export function setupCourierWorkspace(options:CourierWorkspaceOptions) {
  const root=element('section',undefined,'courier-workspace');
  const workspace=new CourierWorkspaceState(options);workspace.refresh();
  const view=mount(Workspace,{target:root,props:{workspace}});flushSync();
  const refresh=()=>{workspace.refresh();flushSync();};
  return {element:root,refresh,show(){workspace.show();flushSync();},hide(){workspace.hide();flushSync();},destroy(){workspace.destroy();void unmount(view);root.replaceChildren();}};
}
