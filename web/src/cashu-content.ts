import {isTestMint,mintUnitLabel,configuredLocalTestMint} from './wallet/mints.ts';
import { byId, element as domElement, formFields } from './dom.ts';
const MAX_TEXT = 16_000, MAX_TOKENS = 4;
const TOKEN_PATTERN = /(?<![A-Za-z0-9_/:?=&-])(?:cashu:)?(cashu[AB][A-Za-z0-9_-]+={0,2})(?![A-Za-z0-9_=-])/g;
export const containsCashu = text => typeof text === 'string' && /cashu[AB][A-Za-z0-9_-]/.test(text);

/** Local parsing only. Metadata does not prove a token is valid or unspent. */
export async function cashuParts(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT || !containsCashu(text)) return [{type:'text',text:String(text ?? '')}];
  const matches = [...text.matchAll(TOKEN_PATTERN)];
  if (!matches.length) return [{type:'text',text}];
  // The SDK is loaded only for token-like messages; this never contacts a mint.
  const { getTokenMetadata } = await import('@cashu/cashu-ts');
  const parts = []; let end = 0, count = 0;
  for (const match of matches) {
    if (count >= MAX_TOKENS) break;
    let info;
    try {
      info = getTokenMetadata(match[1]);
      const mint = new URL(info.mint), amount = info.amount.toString();
      if ((mint.protocol !== 'https:' && mint.href.replace(/\/+$/,'')!==configuredLocalTestMint()) || mint.username || mint.password || mint.search || mint.hash || mint.href.length > 1024 || !/^[a-zA-Z]{1,12}$/.test(info.unit) || !/^[1-9]\d{0,19}$/.test(amount) || !info.proofAmounts.length || info.proofAmounts.length > 256) continue;
      info = {amount,unit:info.unit,mint:mint.href.replace(/\/$/,''),mintName:mint.hostname,token:match[1]};
    } catch { continue; }
    if (match.index > end) parts.push({type:'text',text:text.slice(end,match.index)});
    parts.push({type:'cashu',...info}); end = match.index + match[0].length; count++;
  }
  if (end < text.length || !parts.length) parts.push({type:'text',text:text.slice(end)});
  return parts;
}

export function cashuAmount(part) {
  return new Intl.NumberFormat().format(BigInt(part.amount)) + ' ' + (part.unit === 'sat' ? mintUnitLabel(part.mint||'') : part.unit);
}

const element = <K extends keyof HTMLElementTagNameMap>(doc:Document,tag:K,text?:string,className?:string) => {const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
function hiddenText(doc,text,label) {
  const details=element(doc,'details'),summary=element(doc,'summary',label),field=element(doc,'textarea');
  field.readOnly=true;field.rows=3;field.spellcheck=false;field.setAttribute('aria-label',label==='Show token'?'Cashu token text':'Message text');field.value=text;
  details.append(summary,field);return details;
}

/** Caller guards attachment across conversation changes. Actions never run on render. */
export async function renderCashuContent(text,{document:doc=globalThis.document,onToken,isActive=()=>true,copyText=value=>navigator.clipboard.writeText(value)}: {document?:Document;onToken?:(token:string)=>unknown;isActive?:()=>boolean;copyText?:(value:string)=>Promise<void>}={}) {
  const parts=await cashuParts(text),fragment=doc.createDocumentFragment();
  if(!isActive())return fragment;
  const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string)=>element(doc,tag,text,className);
  for(const part of parts){
    if(part.type==='text'){
      // Invalid, oversized and extra candidates stay hidden too; never flash bearer text.
      if(part.text)fragment.append(containsCashu(part.text)?hiddenText(doc,part.text,'Show message'):node('p',part.text));
      continue;
    }
    const card=node('section',undefined,'chat-token');card.setAttribute('aria-label','Cashu token');
    card.append(node('span',isTestMint(part.mint)?'Test money · no bitcoin value':'Cashu token','small muted'),node('strong',cashuAmount(part),'chat-token-amount'),node('span',part.mintName,'small muted'));
    const actions=node('div',undefined,'chat-token-actions'),status=node('span','Not checked','small muted');status.setAttribute('role','status');
    if(onToken){const receive=node('button','Open in wallet','button secondary');receive.type='button';receive.onclick=()=>{if(isActive())void Promise.resolve(onToken(part.token)).catch(()=>{if(isActive())status.textContent='Wallet unavailable. Try again.'})};actions.append(receive);}
    const copy=node('button','Copy token','text-button');copy.type='button';copy.onclick=()=>{if(isActive())void Promise.resolve().then(()=>{if(isActive())return copyText(part.token)}).then(()=>{if(isActive())status.textContent='Copied · Not checked'}).catch(()=>{if(isActive())status.textContent='Show the token to copy it.'})};actions.append(copy);
    card.append(actions,status,hiddenText(doc,part.token,'Show token'));fragment.append(card);
  }
  return fragment;
}

const NOTE_LABEL = 'Sender-reported; not verified.';
/** A readable payment note, deliberately neither a proof nor an order-paid event. */
export function formatPaymentNote(receipt) {
  if (!receipt || isTestMint(receipt.mint||'') || !['lightning','melt'].includes(receipt.type) || receipt.state !== 'complete' || !/^[1-9]\d{0,19}$/.test(String(receipt.amount))) throw new Error('Choose a completed Lightning payment.');
  const time = receipt.createdAt, milliseconds = time > 1e12 ? time : time * 1000;
  if (!Number.isSafeInteger(time) || milliseconds < 0 || milliseconds > 253402300799999) throw new Error('This payment date is unavailable.');
  return `Lightning payment\nAmount: ${receipt.amount} sats\nDate: ${new Date(milliseconds).toISOString()}\n${NOTE_LABEL}`;
}
export function parsePaymentNote(text) {
  if (typeof text !== 'string' || text.length > 200) return null;
  const match = /^Lightning payment\nAmount: ([1-9]\d{0,19}) sats\nDate: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\nSender-reported; not verified\.$/.exec(text);
  if (!match) return null;
  const time = Date.parse(match[2]);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== match[2]) return null;
  return { amount: match[1], at: time / 1000 };
}
export function renderPaymentNote(note,{document:doc=globalThis.document}={}) {
  const card=element(doc,'section',undefined,'chat-payment');card.setAttribute('aria-label','Reported Lightning payment');
  card.append(element(doc,'span','Lightning payment','small muted'),element(doc,'strong',cashuAmount({amount:note.amount,unit:'sat'}),'chat-token-amount'),element(doc,'span',new Date(note.at*1000).toLocaleString(),'small muted'),element(doc,'span','Sender-reported · Not verified','small muted'));
  return card;
}
