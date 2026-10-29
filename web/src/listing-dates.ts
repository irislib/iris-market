export interface ListingDates {createdAt?:number;expiration?:number|null;originalTags?:readonly (readonly string[])[]}
const valid=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=8.64e12;
/** A signed publication tag survives addressable-event edits. */
export function listingPublishedAt(listing:ListingDates):number|undefined {
  if(!valid(listing.createdAt))return undefined;
  const raw=listing.originalTags?.find(tag=>tag[0]==='published_at')?.[1];
  const published=raw&&/^\d+$/.test(raw)?Number(raw):undefined;
  return valid(published)&&published<=listing.createdAt?published:listing.createdAt;
}
export function expirationFromInput(value:unknown,now=Math.floor(Date.now()/1000)):number|undefined {
  if(value===undefined||value===null||value==='')return undefined;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw new Error('Choose a valid expiry date and time.');
  const milliseconds=new Date(value).getTime(),seconds=milliseconds/1000;
  if(!valid(seconds)||seconds<=now||expirationInput(seconds)!==value)throw new Error('Choose an expiry date and time in the future.');
  return seconds;
}
export function expirationInput(seconds:unknown):string {
  if(!valid(seconds))return '';
  const date=new Date(seconds*1000),pad=(value:number)=>String(value).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
