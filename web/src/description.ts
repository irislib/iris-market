import { Lexer } from 'marked';
import { imageUrl } from './media.ts';

// Marked is a lexer only. No listing-controlled HTML is ever passed to innerHTML.
export function safeDescriptionUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
const text = value => ({text:String(value ?? '')});
const element = (tag, children = [], attributes = {}) => ({tag,children,attributes});
const entities = value => String(value ?? '').replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos);/gi, (_, entity) => {
  if (entity[0] !== '#') return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[entity.toLowerCase()];
  const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : Number(entity.slice(1));
  return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '\ufffd';
});

/** A small safe DOM description, preserving unsupported syntax as text. */
export function descriptionNodes(source) {
  const value = String(source ?? '').slice(0,12000); let budget = 2000;
  function walk(tokens, depth = 0) {
    if (depth > 16) throw new Error('Description nesting limit');
    return tokens.flatMap(token => {
      if (--budget < 0) throw new Error('Description size limit');
      const children = () => token.tokens ? walk(token.tokens,depth+1) : [text(entities(token.text))];
      switch (token.type) {
        case 'space': return [];
        case 'paragraph': return [element('p',children())];
        case 'heading': return [element('h'+Math.min(6,Math.max(3,token.depth+2)),children())];
        case 'strong': return [element('strong',children())];
        case 'em': return [element('em',children())];
        case 'del': return [element('s',children())];
        case 'br': return [element('br')];
        case 'hr': return [element('hr')];
        case 'code': return [element('pre',[element('code',[text(token.text)])])];
        case 'codespan': return [element('code',[text(entities(token.text))])];
        case 'blockquote': return [element('blockquote',children())];
        case 'list': return [element(token.ordered?'ol':'ul',token.items.map(item=>element('li',walk(item.tokens,depth+1))),token.ordered&&Number.isSafeInteger(token.start)&&token.start>0?{start:String(token.start)}:{})];
        case 'link': { const href=safeDescriptionUrl(entities(token.href));return href?[element('a',children(),{href,target:'_blank',rel:'noopener noreferrer nofollow',referrerpolicy:'no-referrer'})]:children(); }
        case 'image': { const href=safeDescriptionUrl(entities(token.href)),src=href&&imageUrl(href,{width:900});return src?[element('img',[],{src,alt:entities(token.text),loading:'lazy',referrerpolicy:'no-referrer',class:'description-image'})]:[text(entities(token.text))]; }
        case 'html': return [text(token.raw || token.text)];
        case 'escape': return [text(token.text)];
        case 'text': return children();
        default: return [text(token.raw || token.text)];
      }
    });
  }
  try { return walk(Lexer.lex(value,{gfm:true,breaks:true})); } catch { return [element('p',[text(value)])]; }
}
export function renderDescription(source, { document:doc=globalThis.document }={}) {
  const root=doc.createElement('div');root.className='detail-description markdown-description';
  function create(node) {
    if ('text' in node) return doc.createTextNode(node.text);
    const target=doc.createElement(node.tag);
    for (const [name,value] of Object.entries(node.attributes)) target.setAttribute(name,value);
    for (const child of node.children) target.append(create(child));
    if (node.tag==='img') target.onerror=()=>target.replaceWith(doc.createTextNode(target.alt));
    return target;
  }
  for (const node of descriptionNodes(source)) root.append(create(node));
  return root;
}
