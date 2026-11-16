import {element} from './dom.ts';
import {translationFields} from './translation.ts';

export function translateListingTitle(listing:{title:string;description?:string}, title:HTMLElement, changed?:(value:string)=>void):HTMLElement {
  return translationFields([listing.title],([value])=>{
    title.textContent=value;
    changed?.(value);
  },{sample:[listing.title,listing.description].filter(Boolean).join('\n')});
}

/** Keep the author's text visible while checking or translating it. */
const linkPattern=/(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]|(?:nostr:)?(?:npub|nprofile)1[02-9ac-hj-np-z]{20,})/gi;
/** Writes text with web addresses and Nostr profile ids as links, using DOM nodes only. */
export function setLinkedText(target:HTMLElement,text:string,profileHref:(id:string)=>string=id=>`/${id}`):void {
  target.replaceChildren();let last=0;
  for(const match of text.matchAll(linkPattern)){
    const value=match[0],index=match.index??0;target.append(text.slice(last,index));last=index+value.length;
    const link=document.createElement('a');link.textContent=value.replace(/^nostr:/i,'');
    if(/^https?:/i.test(value)){link.href=value;link.target='_blank';link.rel='noopener noreferrer nofollow';}
    else link.href=profileHref(value.replace(/^nostr:/i,''));
    target.append(link);
  }
  target.append(text.slice(last));
}
export function translatedParagraph(original:string, className?:string, {links=false}:{links?:boolean}={}):HTMLElement {
  const group=element('div');
  const paragraph=element('p',original,className);
  const write=(value:string)=>{if(links)setLinkedText(paragraph,value);else paragraph.textContent=value;};write(original);
  const control=translationFields([original],([value])=>write(value));
  group.append(paragraph,control);
  return group;
}
