import {element as node} from './dom.ts';
import {imageUrl,createStaticImage} from './media.ts';
import {art} from './art.ts';
import {renderDescription} from './description.ts';
import {listingURL} from './routes.ts';
import {listingPublishedAt,type ListingDates} from './listing-dates.ts';

interface PublicListingEvent {id:string;pubkey:string;created_at:number;kind:number;tags:readonly (readonly string[])[];content:string;sig:string}
interface ListingPresentation extends ListingDates {title:string;side:string;category:string;price:string;currency:string;location:string;imageUrl?:string;description:string;author?:string;id?:string;rawEvent?:PublicListingEvent}
interface ListingPageOptions {
  saved?:boolean;onSave?:(listing:ListingPresentation)=>void;onBuy?:(listing:ListingPresentation)=>void;onProfile?:(key:string)=>void;
  priceNode:(listing:ListingPresentation,className:string)=>HTMLElement;authorRow?:(listing:ListingPresentation)=>HTMLElement;
  isPreview?:boolean;owner?:string;onEdit?:(listing:ListingPresentation)=>void;onToast?:(message:string)=>void;draftPreview?:boolean;localImage?:string;
}
export function renderListingPage(listing:ListingPresentation,{saved=false,onSave=()=>{},onBuy=()=>{},onProfile=()=>{},priceNode,authorRow=()=>null,isPreview=false,owner=undefined,onEdit=undefined,onToast=()=>{},draftPreview=false,localImage=undefined}:ListingPageOptions) {
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
  const context=draftPreview?`${listing.side==='request'?'Buying':'Selling'} · ${listing.category}`:listing.side==='request'?'Buying':listing.category;
  copy.append(node('div',context,'eyebrow'),node('h1',listing.title),priceNode(listing,'detail-price'),node('p',listing.location||'Anywhere','detail-place'));
  if(!draftPreview&&!isPreview&&listing.author)copy.append(authorRow(listing));
  const added=listingPublishedAt(listing),dates=node('p',undefined,'listing-dates small muted');
  const date=(label:string,seconds:number,includeTime=false)=>{const value=new Date(seconds*1000),time=node('time',`${label} ${value.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric',...(includeTime?{hour:'numeric',minute:'2-digit'}:{})})}`);time.dateTime=value.toISOString();time.title=value.toLocaleString();return time;};
  const hasAdded=!draftPreview&&added!==undefined,hasExpiry=Number.isSafeInteger(listing.expiration)&&listing.expiration>0;
  if(hasAdded)dates.append(date('Added',added));
  if(hasExpiry){if(hasAdded)dates.append(document.createTextNode(' · '));dates.append(date('Expires',listing.expiration,true));}
  if(hasAdded||hasExpiry)copy.append(dates);
  if(draftPreview){copy.append(renderDescription(listing.description));wrap.append(media,copy);return wrap;}
  const actions=node('div',undefined,'detail-actions');
  if(!isPreview&&listing.author!==owner){const buy=node('button',listing.side==='request'?'Respond':'Buy','button primary');buy.onclick=()=>onBuy(listing);actions.append(buy);}
  if(!isPreview&&listing.author===owner&&onEdit){const edit=node('button','Edit listing','button primary');edit.onclick=()=>onEdit(listing);actions.append(edit);}
  const save=node('button',saved?'♥ Saved':'♡ Save','button secondary');save.setAttribute('aria-pressed',String(saved));save.onclick=()=>onSave(listing);
  const share=node('button','Copy link','button secondary');share.onclick=async()=>{try{await navigator.clipboard.writeText(listingURL(listing.id,location.href));onToast('Link copied');}catch{onToast('Copy the address from your browser');}};
  actions.append(save,share);copy.append(actions,renderDescription(listing.description));
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
