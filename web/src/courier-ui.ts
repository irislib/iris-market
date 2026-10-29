import {element} from './dom.ts';
import type {OrderView} from './orders.ts';
import {setupServiceAreaPicker} from './service-area-ui.ts';
import {validateServiceArea} from './service-area.ts';
import type {ServiceAreas} from './service-area.ts';

import {courierListingType} from './transport-type.ts';
import type {CourierType} from './transport-type.ts';
export {courierListingType} from './transport-type.ts';
export type {CourierType} from './transport-type.ts';
type CourierSection = 'work' | 'jobs' | 'service';
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
interface CourierWorkspaceOptions extends CourierFeedOptions {
  getOwner:()=>string|undefined;
  getOrders:()=>readonly OrderView[];
  renderOrder:(order:OrderView)=>HTMLElement;
  onReviews:(pubkey:string)=>void;
  onSignIn:()=>void;
  isPreview?:()=>boolean;
  storage?:Pick<Storage,'getItem'|'setItem'>;
  createAreaPicker?:typeof setupServiceAreaPicker;
}
const preferenceKey='market-courier-type-v1';
const clean=(value:string)=>value.normalize('NFKC').trim().toLowerCase();
const terminal=(order:Pick<OrderView,'status'>)=>['delivered','cancelled'].includes(order.status);
const validType=(value:unknown):value is CourierType=>typeof value==='string'&&['parcel','passenger','both'].includes(value);
const browserStorage=()=>{try{return globalThis.localStorage;}catch{return undefined;}};

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
export function setupCourierWorkspace({getListings,getOwner,getOrders,renderOrder,onListing,onAnnounce,onEditListing,renderListing,onReviews,onSignIn,isPreview=()=>false,loadMore,pagination=()=>({}),storage=browserStorage(),createAreaPicker=setupServiceAreaPicker}:CourierWorkspaceOptions) {
  const root=element('section',undefined,'courier-workspace'),tabs=element('nav',undefined,'orders-tabs courier-tabs');tabs.setAttribute('aria-label','Transport');
  const controls=element('form',undefined,'courier-controls'),types=element('div',undefined,'segments courier-types');types.setAttribute('role','radiogroup');types.setAttribute('aria-label','Transport type');
  const areaLabel=element('label',undefined,'courier-area'),caption=element('span','Area'),area=element('input');area.type='search';area.maxLength=160;area.placeholder='City or area';area.autocomplete='off';areaLabel.append(caption,area);
  const content=element('div',undefined,'courier-content'),notice=element('p','','error small');notice.setAttribute('role','alert');
  const areaPicker=createAreaPicker({onChange:()=>{notice.textContent='';}});
  const submit=element('button','Apply','button secondary');submit.type='submit';controls.append(types,areaLabel,areaPicker.element,submit);
  const more=element('button','Load more','button secondary courier-more');more.type='button';more.hidden=true;
  root.append(tabs,controls,notice,content,more);
  let section:CourierSection='work',type:CourierType='parcel',filterArea='',limit=24,loading=false,destroyed=false,visible=true,generation=0,previousOwner=getOwner();
  try{const saved=storage?.getItem(preferenceKey);if(validType(saved))type=saved;}catch{/* Session preferences still work. */}
  const buttons=new Map<CourierType,HTMLButtonElement>();
  function paintTypes(){for(const [key,button] of buttons){button.setAttribute('aria-checked',String(type===key));button.classList.toggle('selected',type===key);button.tabIndex=type===key?0:-1;}}
  function chooseType(value:CourierType){type=value;limit=24;try{storage?.setItem(preferenceKey,value);}catch{}paintTypes();refresh();}
  for(const [key,label] of [['parcel','Deliveries'],['passenger','Rides'],['both','Both']] as const){
    const button=element('button',label);button.type='button';button.setAttribute('role','radio');button.onclick=()=>chooseType(key);
    button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const keys:CourierType[]=['parcel','passenger','both'],index=keys.indexOf(key),next=event.key==='Home'?0:event.key==='End'?2:(index+(['ArrowRight','ArrowDown'].includes(event.key)?1:2))%3;chooseType(keys[next]);buttons.get(keys[next])?.focus();};
    buttons.set(key,button);types.append(button);
  }
  const tabButtons=new Map<CourierSection,HTMLButtonElement>();
  for(const [key,label] of [['work','Find work'],['jobs','My jobs'],['service','My service']] as const){
    const button=element('button',label);button.type='button';button.onclick=()=>{section=key;notice.textContent='';refresh();};tabButtons.set(key,button);tabs.append(button);
  }
  controls.onsubmit=event=>{
    event.preventDefault();notice.textContent='';
    if(section==='work'){filterArea=area.value.trim();limit=24;refresh();return;}
    if(section==='service'&&!isPreview())try{onAnnounce(courierServiceDraft(type,area.value,areaPicker.validate()));}catch(cause){notice.textContent=cause.message||'Could not open the listing editor.';}
  };
  function card(listing:CourierListing):HTMLElement {
    if(renderListing)return renderListing(listing);
    const button=element('button',undefined,'order-card');button.type='button';button.onclick=()=>onListing(listing);
    const copy=element('span',undefined,'order-card-copy');copy.append(element('span',listing.title,'order-card-title'),element('span',listing.location||'Area not specified','small muted'));
    button.append(copy);return button;
  }
  function refresh(){
    if(destroyed)return;
    const owner=getOwner();
    if(owner!==previousOwner){previousOwner=owner;area.value='';filterArea='';areaPicker.setValue(null);limit=24;notice.textContent='';generation++;}
    for(const [key,button] of tabButtons)button.setAttribute('aria-pressed',String(section===key));
    paintTypes();controls.hidden=section==='jobs';caption.textContent=section==='service'?'Area name (optional)':'Area';area.required=false;area.type=section==='service'?'text':'search';submit.textContent=section==='service'?'Offer service':'Apply';submit.disabled=section==='service'&&isPreview();
    if(section==='service'&&visible&&!isPreview())void areaPicker.show();else areaPicker.hide();
    content.replaceChildren();more.hidden=true;
    if(section==='jobs'){
      if(!owner){const signin=element('button','Sign in to see your jobs','button primary');signin.type='button';signin.onclick=onSignIn;content.append(signin);return;}
      const jobs=courierJobs(getOrders(),owner),list=element('div',undefined,'orders-list');
      if(!jobs.length)list.append(element('h3','No jobs yet'),element('p','Deliveries and rides assigned to you appear here.','small muted'));
      else for(const order of jobs)list.append(renderOrder(order));
      content.append(list);return;
    }
    if(isPreview()){content.append(element('p','Switch to the live market to find work or offer a service.','muted'));return;}
    const rows=courierListings(getListings(),{type,area:section==='work'?filterArea:'',side:section==='service'?'offer':'request',owner});
    if(section==='service'){
      if(owner){const reviews=element('button','My reviews','text-button');reviews.type='button';reviews.onclick=()=>onReviews(owner);content.append(reviews);}
      if(rows.length){content.append(element('h3','Your listings'));const list=element('div',undefined,'courier-services');for(const listing of rows){const row=element('div',undefined,'courier-service');row.append(card(listing));if(onEditListing){const edit=element('button','Edit listing','text-button');edit.type='button';edit.onclick=()=>onEditListing(listing);row.append(edit);}list.append(row);}content.append(list);}
      return;
    }
    if(!rows.length)content.append(element('h3','No matching requests'),element('p',filterArea?'Try another area or a different transport type.':'Delivery and ride requests will appear here.','small muted'));
    else{const list=element('div',undefined,renderListing?'listing-grid courier-grid':'orders-list courier-grid');for(const listing of rows.slice(0,limit))list.append(card(listing));content.append(list);}
    const remote=pagination();more.hidden=rows.length<=limit&&!(loadMore&&(remote.hasMore||remote.error));more.disabled=loading||!!remote.loading;more.textContent=more.disabled?'Loading…':remote.error?'Retry':'Load more';
    if(remote.error&&!notice.textContent)notice.textContent='Could not load more requests.';
  }
  more.onclick=async()=>{
    if(loading)return;notice.textContent='';const ticket=++generation;
    const rows=courierListings(getListings(),{type,area:filterArea,owner:getOwner()});
    if(rows.length>limit){limit+=24;refresh();return;}
    if(!loadMore)return;
    limit+=24;loading=true;refresh();
    try{await loadMore();}catch{if(ticket===generation)notice.textContent='Could not load more requests. Try again.';}
    finally{loading=false;if(!destroyed)refresh();}
  };
  refresh();
  return {element:root,refresh,show(){visible=true;refresh();},hide(){visible=false;areaPicker.hide();},destroy(){destroyed=true;generation++;void areaPicker.destroy();root.replaceChildren();}};
}
