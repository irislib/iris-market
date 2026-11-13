import { flushSync, mount } from 'svelte';
import { readEscrowOffer } from './escrow-offer.ts';
import {element} from './dom.ts';
import {formatPrice} from './currency.ts';
import Preview from './composer-view/Preview.svelte';

const rasterTypes=new Set(['image/jpeg','image/png','image/webp']);
export interface DraftFile {name:string;size:number;image?:string}
export type PriceNode=(listing,className:string)=>HTMLElement;

/** These URLs never enter a public event. Release them when leaving the preview. */
export function createDraftFiles(files:File[],urls:Pick<typeof URL,'createObjectURL'|'revokeObjectURL'>=URL) {
  const created:string[]=[];
  try{
    const items:DraftFile[]=files.map(file=>{
      const image=rasterTypes.has(file.type)?urls.createObjectURL(file):undefined;
      if(image)created.push(image);
      return{name:file.name,size:file.size,...(image?{image}:{})};
    });
    return{items,close(){for(const url of created.splice(0))urls.revokeObjectURL(url);}};
  }catch(error){for(const url of created)urls.revokeObjectURL(url);throw error;}
}

export const defaultPriceNode:PriceNode=(listing,className)=>element('p',formatPrice(listing,{preferredCurrency:listing.currency}).primary,className);

/** The listing as the detail page would show it, read from the unsigned draft. */
export function previewListing(draft) {
  const tag=(name:string)=>draft.tags.find(value=>value[0]===name);
  const quote=readEscrowOffer(draft.kind,draft.tags);
  return {escrow:quote.escrow,title:tag('title')[1],side:quote.side??tag('market')?.[1],category:tag('t')[1],price:quote.price??tag('price')?.[1],currency:quote.currency??tag('price')?.[2],location:tag('location')?.[1]??'',imageUrl:tag('image')?.[1],description:draft.content,tags:draft.tags.filter(tag=>tag[0]==='t').map(tag=>tag[1]),expiration:tag('expiration')?Number(tag('expiration')[1]):undefined};
}

export const draftFileSize=(size:number)=>size>=1024*1024?`${(size/(1024*1024)).toFixed(1)} MB`:`${Math.max(1,Math.ceil(size/1024))} KB`;

/** A detached preview root; the composer renders the same component in place. */
export function renderComposerPreview(draft,files:DraftFile[],{priceNode=defaultPriceNode}:{priceNode?:PriceNode}={}):HTMLElement {
  const host=document.createElement('div');
  mount(Preview,{target:host,props:{draft,files,priceNode}});
  flushSync();
  return host.querySelector('.post-preview-content');
}
