import { flushSync, mount } from 'svelte';
import {locationHash} from './map/geohash.ts';
import {listingPin} from './map/listing-pin.ts';
import {BITCOIN_KIND,BITCOIN_TAGS,offerTags} from './escrow-offer.ts';
import { createSurface } from './surface.ts';
import { nhashDecode, toHex } from '@hashtree/core';
import {listingPublishedAt} from './listing-dates.ts';
import {expiryFromChoice} from './expiry.ts';
import {isTransportTag,transportTypeTags} from './transport-type.ts';
import {deliveryDraft,validateDelivery} from './delivery.ts';
import {serviceAreaTags} from './service-area.ts';
import {formatPrice} from './currency.ts';
import Composer from './composer-view/Composer.svelte';
import {ComposerState,type ComposerOptions} from './composer-view/state.svelte.ts';

export function deliveryPreviewLabel(value,currency='EUR',locale=undefined):string|null {
  const delivery=validateDelivery(value);if(!delivery)return null;
  const names=new Intl.DisplayNames([locale||navigator.language||'en'],{type:'region'});
  const destinations=new Intl.ListFormat(locale,{style:'long',type:'conjunction'}).format(delivery.countries.map(code=>names.of(code)));
  if(Number(delivery.price)===0)return `Free delivery to ${destinations}`;
  return `Delivery to ${destinations} · ${formatPrice({price:delivery.price,currency},{preferredCurrency:currency,locale}).primary}`;
}
export function composerControlState({busy=false,editing=false,shippingEnabled=false,category='other'}={}) {
  return {deliveryDisabled:busy||!shippingEnabled,transportDisabled:busy||category!=='transport',keepDisabled:busy||!editing};
}

const MAX_FILES=4, MAX_FILE_BYTES=8*1024*1024;
const rasterTypes=new Set(['image/jpeg','image/png','image/webp']);
const markdownLabel=value=>value.replace(/[\\[\]`*_]/g,'\\$&').replace(/[\r\n]/g,' ');
function attachment(value) {
  if(!value||typeof value.name!=='string'||!value.name||value.name.length>160||/[\u0000-\u001f\u007f]/.test(value.name)||!Number.isSafeInteger(value.size)||value.size<1||value.size>MAX_FILE_BYTES||typeof value.isImage!=='boolean'||typeof value.mime!=='string'||!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.mime)||!/^[a-f0-9]{64}$/.test(value.sha256))throw new Error('An attachment is invalid. Select it again.');
  let url,cid;try{url=new URL(value.url);cid=nhashDecode(value.nhash)}catch{throw new Error('An attachment is invalid. Select it again.')}
  if(url.origin!=='https://cdn.iris.to'||url.username||url.password||url.search||url.hash||!new RegExp('^/'+value.sha256+'\\.[a-z0-9]+$').test(url.pathname)||cid.key||toHex(cid.hash)!==value.sha256||value.isImage&&!rasterTypes.has(value.mime))throw new Error('An attachment is invalid. Select it again.');
  const fileLink=`htree://${value.nhash}/${encodeURIComponent(value.name)}`;
  return {...value,url:url.href,fileLink};
}
export function listingDraft(values, { identifier=crypto.randomUUID(), createdAt=Math.floor(Date.now()/1000), attachments=[], previousExpiration=undefined }={}) {
  validateDelivery(values.shipping);
  const title=String(values.title||'').trim(), description=String(values.description||'').trim(), price=String(values.price??'').trim(), currency=String(values.currency||'EUR').trim().toUpperCase(), location=String(values.location||'').trim(), image=String(values.image||'').trim();
  if(!title||Array.from(title).length>160)throw new Error('Choose a title of up to 160 characters.');
  if(price!==''&&(!/^\d+(?:\.\d{1,8})?$/.test(price)||price.length>24||!Number.isFinite(Number(price))))throw new Error('Enter a positive price, or leave it blank.');
  if(!/^[A-Z]{3,12}$/.test(currency))throw new Error('Choose a currency.');
  if(Array.from(location).length>160)throw new Error('The location is too long.');
  if(!['offer','request'].includes(values.side))throw new Error('Choose Selling or Buying.');
  if(!['home','tech','services','transport','work','other'].includes(values.category))throw new Error('Choose a category.');
  if(image){let url;try{url=new URL(image)}catch{throw new Error('Use a secure image URL.')}if(url.protocol!=='https:'||url.username||url.password)throw new Error('Use a secure image URL.');}
  if(!Array.isArray(attachments)||attachments.length>MAX_FILES)throw new Error('Choose up to four photos or files.');
  const files=attachments.map(attachment), links=files.map(file=>`${file.isImage?'!':''}[${markdownLabel(file.name)}](${file.url})`);
  const content=[description,...links].filter(Boolean).join('\n\n');
  if(new TextEncoder().encode(content).length>12000)throw new Error('The description is too long. Leave room for attachment links.');
  const tags=[['d',identifier],['title',title],['k',values.side==='request'?'buy':'sell'],['t',values.category],['price',price,currency],['status','active'],['published_at',String(createdAt)],['client','Iris Market']];
  const labels:unknown[]=Array.isArray(values.tags)?values.tags:String(values.tags||'').split(',');
  const extraTags=[...new Set(labels.map(value=>{if(typeof value!=='string')throw new Error('Choose up to eight short tags.');return value.trim().replace(/^#/, '').toLowerCase();}).filter(Boolean))];
  if(extraTags.length>8||extraTags.some(tag=>Array.from(tag).length>60||/[\u0000-\u001f\u007f]/.test(tag)))throw new Error('Choose up to eight tags, each up to 60 characters.');
  const selectedType=values.category==='transport'?values.transportType:undefined;const generated=transportTypeTags(selectedType);
  for(const label of [...new Set([...extraTags.filter(tag=>!selectedType||!isTransportTag(tag)),...generated])])if(label!==values.category)tags.push(['t',label]);
  const expiration=expiryFromChoice(values.expiration,createdAt,previousExpiration);
  if(expiration!==undefined)tags.push(['expiration',String(expiration)]);
  const pin = Object.hasOwn(values,'pinCoordinates') ? listingPin(String(values.pinCoordinates), String(values.pinPrecision)) : null;
  const hash = pin?.hash ?? (!Object.hasOwn(values,'pinCoordinates') ? locationHash(location) : undefined);
  const label = Object.hasOwn(values,'pinCoordinates') && locationHash(location) ? location.slice(0,location.lastIndexOf('#')).trim() : location;
  if(pin?.uri)tags.push(['r',pin.uri]);
  if(hash)for(let n=1;n<=hash.length;n++)tags.push(['g',hash.slice(0,n)]);
  if(label||hash)tags.push(['location',label||'#'+hash]);if(image)tags.push(['image',image]);
  if(values.serviceAreas)tags.push(...serviceAreaTags(values.serviceAreas));
  for(const file of files){
    if(file.isImage)tags.push(['image',file.url]);
    tags.push(['imeta',`url ${file.url}`,`x ${file.sha256}`,`m ${file.mime}`,`size ${file.size}`,`alt ${file.name}`],['r',file.fileLink]);
  }
  return {...offerTags(tags,values.escrow),created_at:createdAt,content};
}

/** Keep the address and unrelated public metadata when a merchant edits a listing. */
export function revisedListingDraft(values, previous, attachments=[]) {
  // A revision keeps its addressable kind even if optional tools were turned off.
  const offer=values.escrow ?? previous.escrow;
  if((offer?.trade==='bitcoin_fiat')!==(previous.rawEvent?.kind===BITCOIN_KIND))throw Error('Create a new listing to change the trade type.');
  const draft=listingDraft({...values,escrow:offer,expiration:values.expiration??'keep'},{identifier:previous.identifier,createdAt:Math.max(Math.floor(Date.now()/1000),previous.createdAt+1),attachments,previousExpiration:previous.expiration});
  draft.tags.find(tag=>tag[0]==='published_at')[1]=String(listingPublishedAt(previous)??previous.createdAt);
  const replaced=new Set(['d','title','client','market','price','location','status','published_at','expiration','iris-escrow',...(previous.rawEvent?.kind===BITCOIN_KIND?BITCOIN_TAGS:[])]);
  for(const tag of previous.originalTags||[]){
    if(tag[0]==='k'&&['buy','sell'].includes(tag[1]) || tag[0]==='type'&&['want_buy','want_rent'].includes(tag[1]) || tag[0]==='t'&&tag[1]==='market:request')continue;
    if(Object.hasOwn(values,'pinCoordinates') && (tag[0]==='g' && !['pickup','destination'].includes(tag[2]) || tag[0]==='r' && tag[1]?.startsWith('geo:')))continue;
    if(tag[0]==='g'&&tag.length===2&&values.location!==previous.location&&(locationHash(values.location)||locationHash(previous.location)))continue;
    if(values.category==='transport'&&values.transportType&&tag[0]==='t'&&isTransportTag(tag[1]))continue;
    if(Object.hasOwn(values,'serviceAreas')&&(tag[0]==='service_area'||tag[0]==='g'&&['pickup','destination'].includes(tag[2])))continue;
    if(Object.hasOwn(values,'shipping')&&tag[0]==='shipping_option')continue;
    if(replaced.has(tag[0])||tag[0]==='t'&&(tag[1]===previous.category||Object.hasOwn(values,'tags'))||tag[0]==='image'&&tag[1]===previous.imageUrl)continue;
    if(!draft.tags.some(value=>JSON.stringify(value)===JSON.stringify(tag)))draft.tags.push([...tag]);
  }
  return draft;
}

export function closedBitcoinDraft(listing) {
  if(listing.rawEvent?.kind!==BITCOIN_KIND||listing.escrow?.trade!=='bitcoin_fiat')throw Error('Choose a bitcoin offer.');
  return {kind:BITCOIN_KIND,created_at:Math.max(Math.floor(Date.now()/1000),listing.createdAt+1),content:listing.description,
    tags:listing.originalTags.map(t=>t[0]==='s'?['s','canceled']:[...t])};
}

/** A signed retry is the same publication, including its exact deadline. */
export async function signedListingForPublish(values,{previous=undefined,identifier=undefined,attachments=[],pendingEvent=undefined,signEvent}) {
  if(pendingEvent)return pendingEvent;
  const draft=previous?revisedListingDraft(values,previous,attachments):listingDraft(values,{identifier,attachments});
  return signEvent(draft);
}

/** Sign the complete pair before any local enqueue or relay publication. */
export async function signedListingPublication(values,{previous=undefined,identifier=undefined,attachments=[],pendingEvent=undefined,pendingShipping=undefined,signEvent,onShipping=(_event)=>{}}) {
  if(pendingEvent)return {event:pendingEvent,shipping:pendingShipping};
  const delivery=validateDelivery(values.shipping);
  // Reject every listing field before requesting even the option signature.
  if(previous)revisedListingDraft(values,previous,attachments);else listingDraft(values,{identifier,attachments});
  let shipping=pendingShipping;
  if(delivery&&!shipping){shipping=await signEvent(deliveryDraft(delivery,String(values.currency||'EUR').trim().toUpperCase()));onShipping(shipping);}
  const event=await signedListingForPublish(values,{previous,identifier,attachments,signEvent:draft=>{
    if(shipping)draft.tags.push(['shipping_option',`30406:${shipping.pubkey}:${shipping.tags.find(tag=>tag[0]==='d')[1]}`]);
    return signEvent(draft);
  }});
  return {event,shipping};
}

/** Keep successful uploads across retry without changing the original selected files. */
export function createAttachmentSelection(upload) {
  let entries=[];
  return {
    add(files){const next=[...files];if(entries.length+next.length>MAX_FILES)throw new Error('Choose up to four photos or files.');for(const file of next)if(!file||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_FILE_BYTES||typeof file.arrayBuffer!=='function')throw new Error('Each file must be between 1 byte and 8 MiB.');entries.push(...next.map(file=>({file,result:null})));},
    remove(index){entries.splice(index,1);},
    clear(){entries=[];},
    items(){return entries.map(entry=>({file:entry.file,uploaded:Boolean(entry.result)}));},
    async uploadAll({signal,onFile=()=>{}}:{signal?:AbortSignal;onFile?:(index:number,total:number)=>void}={}){const results=[];for(const[index,entry]of entries.entries()){if(signal?.aborted)throw new DOMException('Upload cancelled','AbortError');if(!entry.result){onFile(index,entries.length);entry.result=attachment(await upload(entry.file,{signal}));}results.push(entry.result);}return results;},
  };
}

export function setupComposer(options:ComposerOptions) {
  const {account,page=undefined,onNavigate=()=>{},onClose=()=>{}}=options;
  const dialog=createSurface({className:'composer-dialog',label:'Post a listing',pageHost:page,onOpen:onNavigate,onClose});
  const composer=new ComposerState(options,dialog);
  mount(Composer,{target:dialog,props:{composer}});
  flushSync();
  composer.attach();
  // Callers read the dialog right after these calls.
  const sync=<T,>(value:T)=>{flushSync();return value;};
  account.onReady(()=>{if(composer.pendingOpen)sync(composer.open());});
  document.getElementById('post-button').onclick=()=>sync(composer.open());
  window.addEventListener('pagehide',()=>composer.destroy());
  return {
    open:()=>sync(composer.open()),
    edit:listing=>sync(composer.edit(listing)),
    prefill:values=>sync(composer.prefill(values)),
    closeBitcoin:listing=>composer.closeBitcoin(listing),
    hide:(settings:{preservePending?:boolean}={})=>sync(composer.hide(settings)),
  };
}
