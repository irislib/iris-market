import {element} from './dom.ts';
import {translationFields} from './translation.ts';

export function translateListingTitle(listing:{title:string;description?:string}, title:HTMLElement, changed?:(value:string)=>void):HTMLElement {
  return translationFields([listing.title],([value])=>{
    title.textContent=value;
    changed?.(value);
  },{sample:[listing.title,listing.description].filter(Boolean).join('\n')});
}

/** Keep the author's text visible while checking or translating it. */
export function translatedParagraph(original:string, className?:string):HTMLElement {
  const group=element('div');
  const paragraph=element('p',original,className);
  const control=translationFields([original],([value])=>{paragraph.textContent=value;});
  group.append(paragraph,control);
  return group;
}
