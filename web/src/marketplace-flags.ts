export type MarketplaceTool = 'escrow';
let activeOwner = '';
const setting = (id:MarketplaceTool, owner:string) => `market-tools-v1/${owner || 'guest'}/${id}`;
export function marketplaceToolEnabled(id:MarketplaceTool, owner=activeOwner):boolean {
  try { return localStorage.getItem(setting(id,owner))==='1'; } catch { return false; }
}
export function saveMarketplaceTool(id:MarketplaceTool, enabled:boolean, owner=activeOwner) {
  localStorage.setItem(setting(id,owner), enabled?'1':'0');
}
/** Switches the profile whose tool settings apply; returns the previous one. */
export function setMarketplaceOwner(owner:string):string {
  const previous=activeOwner;activeOwner=owner;
  // A choice made before signing in carries over to a profile that has not made its own.
  if(!previous&&owner)try{for(const id of ['escrow'] as MarketplaceTool[])if(localStorage.getItem(setting(id,owner))===null&&localStorage.getItem(setting(id,''))!==null)localStorage.setItem(setting(id,owner),localStorage.getItem(setting(id,''))!);}catch{}
  return previous;
}
