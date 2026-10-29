import {element} from './dom.ts';
import {formatPrice} from './currency.ts';
import {renderListingPage} from './listing-page.ts';

const rasterTypes=new Set(['image/jpeg','image/png','image/webp']);
export interface DraftFile {name:string;size:number;image?:string}

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

export function renderComposerPreview(draft,files:DraftFile[],{priceNode=(listing,className)=>element('p',formatPrice(listing,{preferredCurrency:listing.currency}).primary,className)}={}) {
  const tag=(name:string)=>draft.tags.find(value=>value[0]===name);
  const listing={title:tag('title')[1],side:tag('market')[1],category:tag('t')[1],price:tag('price')[1],currency:tag('price')[2],location:tag('location')?.[1]??'',imageUrl:tag('image')?.[1],description:draft.content,expiration:tag('expiration')?Number(tag('expiration')[1]):undefined};
  const selected=listing.imageUrl?undefined:files.find(file=>file.image)?.image;
  const root=element('div',undefined,'post-preview-content');
  root.append(renderListingPage(listing,{priceNode,draftPreview:true,localImage:selected}));
  if(files.length){
    const attachments=element('div',undefined,'post-preview-files');
    for(const file of files){
      const item=element('figure');
      if(file.image){const image=element('img');image.src=file.image;image.alt=file.name;image.onerror=()=>image.remove();item.append(image);}
      const label=element('figcaption'),size=file.size>=1024*1024?`${(file.size/(1024*1024)).toFixed(1)} MB`:`${Math.max(1,Math.ceil(file.size/1024))} KB`;
      label.append(element('span',file.name),element('small',size,'muted'));item.append(label);attachments.append(item);
    }
    root.append(attachments);
  }
  return root;
}
