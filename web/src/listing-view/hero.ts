import {element as node} from '../dom.ts';
import {imageUrl,createStaticImage} from '../media.ts';
import {art} from '../art.ts';

/**
 * The detail image starts still. The original (possibly animated) source is
 * fetched only after the reader selects it, and a failed original falls back
 * to the still or the category artwork rather than retrying the original.
 */
export function heroImage(listing:{title:string;category?:string;imageUrl?:string}, {draftPreview=false,localImage=undefined as string|undefined}={}) {
  const local=draftPreview&&typeof localImage==='string'&&localImage.startsWith('blob:')?localImage:null;
  const stillImage=local?node('img',undefined,'detail-art'):createStaticImage(listing.imageUrl,{width:1200,className:'detail-art',alt:listing.title,fallback:art(listing),loading:'eager'});
  if(local){(stillImage as HTMLImageElement).src=local;(stillImage as HTMLImageElement).alt=listing.title;}
  const original=!draftPreview&&/^(?:https?:)?\/\//i.test(listing.imageUrl||'')?imageUrl(listing.imageUrl,{width:1200}):null;
  const canvasStill=stillImage.tagName==='CANVAS';
  const image=canvasStill?node('img',undefined,'detail-art'):stillImage as HTMLImageElement;
  image.alt=listing.title;image.referrerPolicy='no-referrer';image.decoding='async';
  const still=canvasStill?null:image.src;
  const stillError=image.onerror;
  /** Show the original or the still. `failed` runs when the original cannot load. */
  function select(showingOriginal:boolean, failed:()=>void){
    if(canvasStill){
      stillImage.hidden=showingOriginal;image.hidden=!showingOriginal;
      if(showingOriginal){image.onerror=()=>{image.onerror=null;failed();stillImage.hidden=false;image.hidden=true;};image.src=original;}
      return;
    }
    image.onerror=showingOriginal?()=>{image.onerror=null;failed();image.src=art(listing);}:stillError;
    image.src=showingOriginal?original:still;
  }
  function setAlt(value:string){image.alt=value;if(canvasStill)stillImage.setAttribute('aria-label',value);}
  return {
    local,
    nodes:canvasStill?[stillImage,image]:[stillImage],
    canToggle:!!original&&(canvasStill||original!==still),
    select,setAlt,
  };
}
