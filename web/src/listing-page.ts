import {fiatMethodLabel} from './escrow-offer.ts';
import {element as node} from './dom.ts';
import {imageUrl,createStaticImage} from './media.ts';
import {art} from './art.ts';
import {renderDescription} from './description.ts';
import {translationFields} from './translation.ts';
import {listingURL,validListingId} from './routes.ts';
import {listingPublishedAt,type ListingDates} from './listing-dates.ts';
import {relativeExpiry} from './expiry.ts';
import {courierListingType} from './transport-type.ts';

interface PublicListingEvent {id:string;pubkey:string;created_at:number;kind:number;tags:readonly (readonly string[])[];content:string;sig:string}
interface ListingPresentation extends ListingDates {externalOrder?:import('./bitcoin-orders.ts').BitcoinQuote;escrow?:import('./escrow-offer.ts').EscrowOffer;title:string;side:string;category:string;tags?:readonly string[];price:string;currency:string;location:string;imageUrl?:string;description:string;author?:string;id?:string;rawEvent?:PublicListingEvent}
interface ListingPageOptions {
  saved?:boolean;onSave?:(listing:ListingPresentation)=>void;onBuy?:(listing:ListingPresentation)=>void;onProfile?:(key:string)=>void;
  priceNode:(listing:ListingPresentation,className:string)=>HTMLElement;authorRow?:(listing:ListingPresentation)=>HTMLElement;
  isPreview?:boolean;owner?:string;onCloseBitcoin?:(listing:ListingPresentation)=>Promise<void>;onEdit?:(listing:ListingPresentation)=>void;onToast?:(message:string)=>void;draftPreview?:boolean;localImage?:string;
}
function listingShare(url:string, onToast:(message:string)=>void) {
  const share=node('button','Share','button secondary listing-share');
  share.type='button';
  async function copyLink() {
    try { await navigator.clipboard.writeText(url); onToast('Link copied'); }
    catch { onToast('Copy the address from your browser'); }
  }
  if (typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare({url}))) {
    const choices=node('div',undefined,'listing-share-choices');
    choices.popover='auto';
    choices.setAttribute('role','group');
    choices.setAttribute('aria-label','Share listing');
    share.popoverTargetElement=choices;
    const copy=node('button','Copy link'),send=node('button','Share via…');
    copy.autofocus=true;
    copy.onclick=()=>{ choices.hidePopover(); void copyLink(); };
    send.onclick=async()=>{
      choices.hidePopover();
      try { await navigator.share({url}); }
      catch (error) { if (!(error instanceof Error && error.name==='AbortError')) onToast('Could not share this listing'); }
    };
    choices.ontoggle=event=>{
      if (event.newState!=='open') return;
      const rect=share.getBoundingClientRect();
      choices.style.left=Math.max(8,Math.min(rect.left,innerWidth-choices.offsetWidth-8))+'px';
      choices.style.top=(rect.bottom+6+choices.offsetHeight<=innerHeight-8 ? rect.bottom+6 : Math.max(8,rect.top-choices.offsetHeight-6))+'px';
    };
    choices.append(copy,send);
    return [share,choices];
  }
  share.onclick=copyLink;
  return [share];
}

export function renderListingPage(listing:ListingPresentation,{saved=false,onSave=()=>{},onBuy=()=>{},onProfile=()=>{},priceNode,authorRow=()=>null,isPreview=false,owner=undefined,onEdit=undefined,onCloseBitcoin=undefined,onToast=()=>{},draftPreview=false,localImage=undefined}:ListingPageOptions) {
  const wrap=node('article',undefined,'detail-layout');
  const media=node('div',undefined,'detail-media');
  const local=draftPreview&&typeof localImage==='string'&&localImage.startsWith('blob:')?localImage:null;
  const stillImage=local?node('img',undefined,'detail-art'):createStaticImage(listing.imageUrl,{width:1200,className:'detail-art',alt:listing.title,fallback:art(listing),loading:'eager'});
  if(local){(stillImage as HTMLImageElement).src=local;(stillImage as HTMLImageElement).alt=listing.title;}
  // Original animation starts only after the explicit control is selected.
  const original=!draftPreview&&/^(?:https?:)?\/\//i.test(listing.imageUrl||'')?imageUrl(listing.imageUrl,{width:1200}):null;
  const canvasStill=stillImage.tagName==='CANVAS';
  const image=canvasStill?node('img',undefined,'detail-art'):stillImage as HTMLImageElement;
  image.alt=listing.title;image.referrerPolicy='no-referrer';image.decoding='async';
  const still=canvasStill?null:image.src;
  const stillError=image.onerror;
  let showingOriginal=false,originalButton:HTMLButtonElement|undefined;
  const updateImageButton=()=>{if(originalButton){originalButton.setAttribute('aria-pressed',String(showingOriginal));originalButton.setAttribute('aria-label',showingOriginal?'Pause image':'Show original image');originalButton.title=showingOriginal?'Pause image':'Show original';}};
  function selectImage(originalSelected:boolean){
    showingOriginal=originalSelected;updateImageButton();
    if(canvasStill){stillImage.hidden=showingOriginal;image.hidden=!showingOriginal;if(showingOriginal){image.onerror=()=>{image.onerror=null;showingOriginal=false;updateImageButton();stillImage.hidden=false;image.hidden=true;};image.src=original;}return;}
    image.onerror=showingOriginal?()=>{image.onerror=null;showingOriginal=false;updateImageButton();image.src=art(listing);}:stillError;
    image.src=showingOriginal?original:still;
  }
  media.append(stillImage);if(canvasStill)media.append(image);
  if(original&&(canvasStill||original!==still)){originalButton=node('button',undefined,'image-original-toggle');originalButton.type='button';originalButton.onclick=()=>selectImage(!showingOriginal);media.append(originalButton);}
  selectImage(false);
  const copy=node('div',undefined,'detail-copy');
  const transport=listing.category==='transport'?courierListingType(listing):null;
  const category=transport?({parcel:'Delivery',passenger:'Passenger ride',both:'Delivery and passenger rides'}[transport]):listing.category;
  const bitcoin=listing.escrow?.trade==='bitcoin_fiat'?listing.escrow:undefined;
  if((bitcoin||listing.externalOrder) && !local && !listing.imageUrl){wrap.classList.add('detail-quote-only');media.hidden=true;}
  const context=listing.externalOrder?listing.externalOrder.platform:bitcoin?(listing.side==='request'?'Buying bitcoin':'Selling bitcoin'):draftPreview?`${listing.side==='request'?'Buying':'Selling'} · ${category}`:listing.side==='request'?`Buying${transport?` · ${category}`:''}`:category;
  const title=node('h1',listing.title);
  copy.append(node('div',context,'eyebrow'),title,priceNode(listing,'detail-price'),...(listing.externalOrder?[]:[node('p',listing.location||'Anywhere','detail-place')]));
  if(bitcoin)copy.append(node('p',bitcoin.sats.toLocaleString()+' sats · '+fiatMethodLabel(bitcoin.method),'detail-quote'));
  if(!draftPreview&&!isPreview&&listing.author&&!listing.externalOrder)copy.append(authorRow(listing));
  const added=listingPublishedAt(listing),dates=node('p',undefined,'listing-dates small muted');
  const date=(label:string,seconds:number,includeTime=false)=>{const value=new Date(seconds*1000),time=node('time',`${label} ${value.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric',...(includeTime?{hour:'numeric',minute:'2-digit'}:{})})}`);time.dateTime=value.toISOString();time.title=value.toLocaleString();return time;};
  const hasAdded=!draftPreview&&added!==undefined,expiry=relativeExpiry(listing.expiration),hasExpiry=expiry!==null;
  if(hasAdded)dates.append(date('Added',added));
  if(hasExpiry){if(hasAdded)dates.append(document.createTextNode(' · '));const time=node('time',expiry);time.dateTime=new Date(listing.expiration*1000).toISOString();dates.append(time);}
  if(hasAdded||hasExpiry)copy.append(dates);
  if(draftPreview){copy.append(renderDescription(listing.description));wrap.append(media,copy);return wrap;}
  const actions=node('div',undefined,'detail-actions');
  if(!isPreview&&!listing.externalOrder&&listing.author!==owner){const buy=node('button',bitcoin?(listing.side==='request'?'Message buyer':'Message seller'):listing.side==='request'?'Respond':'Buy','button primary');buy.onclick=()=>onBuy(listing);actions.append(buy);}
  if(!isPreview&&!listing.externalOrder&&listing.author===owner&&onEdit){const edit=node('button','Edit listing','button primary');edit.onclick=()=>onEdit(listing);actions.append(edit);}
  if(!isPreview && bitcoin && listing.author===owner && onCloseBitcoin){
    const close=node('details',undefined,'account-option'),confirm=node('button','Close offer','button secondary'),problem=node('p','','error small');
    confirm.type='button';problem.setAttribute('role','alert');
    close.append(node('summary','Close offer'),node('p','People will no longer be able to take this quote.','small muted'),confirm,problem);
    confirm.onclick=async()=>{confirm.disabled=true;try{await onCloseBitcoin(listing);}catch(error){problem.textContent=error.message;confirm.disabled=false;}};
    actions.append(close);
  }
  const save=node('button',saved?'♥ Saved':'♡ Save','button secondary');save.dataset.favoriteId=listing.id;save.setAttribute('aria-pressed',String(saved));save.onclick=()=>onSave(listing);
  actions.append(save);
  if (validListingId(listing.id)) actions.append(...listingShare(listingURL(listing.id), onToast));
  if(listing.externalOrder){
    const q=listing.externalOrder,terms=node('dl',undefined,'order-terms');
    for(const [label,value] of [['Payment method',q.methods],['Settlement',q.layer],
      ['Bitcoin amount',q.quantity===null?'':q.quantity.toLocaleString()+' sats'],['Premium',q.premium===null?'':q.premium+'%']]){
      if(value)terms.append(node('dt',label),node('dd',value));
    }
    copy.append(terms,actions);
  }else {
    const prose:Text[]=[];
    const description=renderDescription(listing.description,{prose});
    const fields=[title,...prose];
    const control=translationFields(fields.map(field=>field.textContent),values=>{
      fields.forEach((field,index)=>{field.textContent=values[index];});
      image.alt=values[0];
      if(canvasStill)stillImage.setAttribute('aria-label',values[0]);
    });
    copy.append(control,actions,description);
  }
  if(isPreview)copy.append(node('p','Sample listing','small muted'));
  wrap.append(media,copy);
  if(!isPreview&&listing.rawEvent){
    // Only the verified public wire event is exported, never the listing view
    // model, account state, private messages or computed relationship data.
    const {id,pubkey,created_at,kind,tags,content,sig}=listing.rawEvent;
    const json=JSON.stringify({id,pubkey,created_at,kind,tags,content,sig},null,2);
    const details=node('details',undefined,'listing-raw-event'),summary=node('summary','Raw event');
    const pre=node('pre'),code=node('code',json);pre.tabIndex=0;pre.setAttribute('aria-label','Raw public event');pre.append(code);
    const tools=node('div',undefined,'listing-raw-tools'),copyEvent=node('button','Copy event','text-button'),status=node('span',undefined,'small muted');
    copyEvent.type='button';status.setAttribute('role','status');
    copyEvent.onclick=async()=>{try{await navigator.clipboard.writeText(json);status.textContent='Copied';}catch{status.textContent='Could not copy. Select the text below.';}};
    tools.append(copyEvent,status);details.append(summary,tools,pre);wrap.append(details);
  }
  return wrap;
}
