import {element as node} from './dom.ts';
import {imageUrl} from './media.ts';
import {art} from './art.ts';
import {renderDescription} from './description.ts';
import {listingURL} from './routes.ts';

export function renderListingPage(listing,{saved,onSave,onBuy,onProfile,priceNode,authorRow,isPreview,owner,onEdit,onToast}) {
  const wrap=node('article',undefined,'detail-layout');
  const media=node('div',undefined,'detail-media');
  const image=node('img',undefined,'detail-art');image.alt=listing.title;image.referrerPolicy='no-referrer';image.decoding='async';
  image.src=imageUrl(listing.imageUrl,{width:1200})||art(listing);image.onerror=()=>{image.onerror=null;image.src=art(listing);};media.append(image);
  const copy=node('div',undefined,'detail-copy');
  copy.append(node('div',listing.side==='request'?'Buying':listing.category,'eyebrow'),node('h1',listing.title),priceNode(listing,'detail-price'),node('p',listing.location||'Anywhere','detail-place'));
  if(!isPreview&&listing.author)copy.append(authorRow(listing));
  const actions=node('div',undefined,'detail-actions');
  if(!isPreview&&listing.author!==owner){const buy=node('button',listing.side==='request'?'Respond':'Buy','button primary');buy.onclick=()=>onBuy(listing);actions.append(buy);}
  if(!isPreview&&listing.author===owner&&onEdit){const edit=node('button','Edit listing','button primary');edit.onclick=()=>onEdit(listing);actions.append(edit);}
  const save=node('button',saved?'♥ Saved':'♡ Save','button secondary');save.setAttribute('aria-pressed',String(saved));save.onclick=()=>onSave(listing);
  const share=node('button','Copy link','button secondary');share.onclick=async()=>{try{await navigator.clipboard.writeText(listingURL(listing.id,location.href));onToast('Link copied');}catch{onToast('Copy the address from your browser');}};
  actions.append(save,share);copy.append(actions,renderDescription(listing.description));
  if(isPreview)copy.append(node('p','Sample listing','small muted'));
  wrap.append(media,copy);return wrap;
}
