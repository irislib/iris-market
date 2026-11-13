import {flushNow} from './flush.ts';
import {mount} from 'svelte';
import {saveMarketplaceTool, setMarketplaceOwner} from '../marketplace-flags.ts';
import MarketplaceFlags from './MarketplaceFlags.svelte';

/** Kept apart from marketplace-flags.ts so messaging (also run by Node scripts) never imports components. */
export function setupMarketplaceFlags(account:{state():{ownerPubkey?:string|null};onState(listener:()=>void):unknown}) {
  const preferences=document.querySelector('#preferences-dialog');
  const flags=preferences?mount(MarketplaceFlags,{target:preferences,props:{onchange(id,enabled){
    let error='';
    try{saveMarketplaceTool(id,enabled);}catch{error='Settings could not be saved on this device.';}
    sync();window.dispatchEvent(new Event('market-tools-change'));
    return error;
  }}}):undefined;
  flushNow();
  function sync(){
    const owner=account.state().ownerPubkey||'',previous=setMarketplaceOwner(owner);
    flags?.refresh();
    if(previous!==owner)window.dispatchEvent(new Event('market-tools-change'));
  }
  account.onState(sync);window.addEventListener('storage',()=>{sync();window.dispatchEvent(new Event('market-tools-change'));});sync();
  return preferences?.lastElementChild as HTMLElement|undefined;
}
