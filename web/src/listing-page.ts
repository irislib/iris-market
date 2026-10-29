import {element as node} from './dom.ts';
import {imageUrl} from './media.ts';
import {art} from './art.ts';
import {renderDescription} from './description.ts';
import {listingURL} from './routes.ts';
import {listingPublishedAt,type ListingDates} from './listing-dates.ts';

interface ListingPresentation extends ListingDates {title:string;side:string;category:string;price:string;currency:string;location:string;imageUrl?:string;description:string;author?:string;id?:string}
interface ListingPageOptions {
  saved?:boolean;onSave?:(listing:ListingPresentation)=>void;onBuy?:(listing:ListingPresentation)=>void;onProfile?:(key:string)=>void;
  priceNode:(listing:ListingPresentation,className:string)=>HTMLElement;authorRow?:(listing:ListingPresentation)=>HTMLElement;
  isPreview?:boolean;owner?:string;onEdit?:(listing:ListingPresentation)=>void;onToast?:(message:string)=>void;draftPreview?:boolean;localImage?:string;
}
export function renderListingPage(listing:ListingPresentation,{saved=false,onSave=()=>{},onBuy=()=>{},onProfile=()=>{},priceNode,authorRow=()=>null,isPreview=false,owner=undefined,onEdit=undefined,onToast=()=>{},draftPreview=false,localImage=undefined}:ListingPageOptions) {
  const wrap=node('article',undefined,'detail-layout');
  const media=node('div',undefined,'detail-media');
  const image=node('img',undefined,'detail-art');image.alt=listing.title;image.referrerPolicy='no-referrer';image.decoding='async';
  image.src=draftPreview&&typeof localImage==='string'&&localImage.startsWith('blob:')?localImage:imageUrl(listing.imageUrl,{width:1200})||art(listing);image.onerror=()=>{image.onerror=null;image.src=art(listing);};media.append(image);
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
  wrap.append(media,copy);return wrap;
}
