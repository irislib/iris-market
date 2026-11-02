import {element} from './dom.ts';

export type MarketplaceTool = 'escrow';
let activeOwner = '';
const setting = (id:MarketplaceTool, owner:string) => `market-tools-v1/${owner || 'guest'}/${id}`;
export function marketplaceToolEnabled(id:MarketplaceTool, owner=activeOwner):boolean {
  try { return localStorage.getItem(setting(id,owner))==='1'; } catch { return false; }
}
export function saveMarketplaceTool(id:MarketplaceTool, enabled:boolean, owner=activeOwner) {
  localStorage.setItem(setting(id,owner), enabled?'1':'0');
}
export function setupMarketplaceFlags(account) {
  const section=element('details',undefined,'settings-section');
  section.append(element('summary','Optional marketplace tools'));
  const error=element('p',undefined,'error small');error.setAttribute('role','alert');
  const switches=new Map<MarketplaceTool,HTMLInputElement>();
  for(const [id,title,detail] of [
    ['escrow','Escrow','Agree on a third person to help settle a payment.'],
  ] as const){
    const row=element('label',title,'checkbox-label'),input=element('input');
    input.type='checkbox';row.prepend(input);section.append(row,element('p',detail,'small muted'));switches.set(id,input);
    input.onchange=()=>{try{saveMarketplaceTool(id,input.checked);error.textContent='';}catch{error.textContent='Settings could not be saved on this device.';}
      sync();window.dispatchEvent(new Event('market-tools-change'));};
  }
  section.append(error);document.querySelector('#preferences-dialog')?.append(section);
  function sync(){
    const previous=activeOwner;activeOwner=account.state().ownerPubkey||'';
    for(const [id,input] of switches)input.checked=marketplaceToolEnabled(id);
    if(previous!==activeOwner)window.dispatchEvent(new Event('market-tools-change'));
  }
  account.onState(sync);window.addEventListener('storage',()=>{sync();window.dispatchEvent(new Event('market-tools-change'));});sync();
  return section;
}
