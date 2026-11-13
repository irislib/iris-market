import {flushNow} from './account/flush.ts';
import {mount} from 'svelte';
import TradeTools from './account/TradeTools.svelte';

export {marketplaceToolEnabled} from './marketplace-flags.ts';

export function composerTradeTools(form:HTMLFormElement){
  const tabs=form.querySelector('.post-side-tabs');
  // Mounted off-document and moved into the composer's form, so the form never gains a second
  // Svelte event root (which re-runs the composer's own delegated handlers). Its listeners are direct.
  const fragment=document.createDocumentFragment();
  const tools=mount(TradeTools,{target:fragment as unknown as Element,props:{form}});
  flushNow();tabs.after(...fragment.childNodes);tools.sync();flushNow();
  // The composer reads the price label and field state right after these calls.
  return {
    sync(editing?:boolean){tools.sync(editing);flushNow();},
    setEditingOffer(offer){tools.setEditingOffer(offer);flushNow();},
    choices(){return tools.choices();},
  };
}
