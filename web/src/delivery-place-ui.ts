import {flushSync,mount,unmount} from 'svelte';
import {element} from './dom.ts';
import DeliveryPlace from './service-area-view/DeliveryPlace.svelte';
import {DeliveryPlaceState,type DeliveryPlaceInputOptions} from './service-area-view/place-state.svelte.ts';
import type {DeliveryPlace as Place} from './orders.ts';

/** Private, transient meeting point editor. Nothing is saved or sent by this control. */
export function createDeliveryPlaceInput(options:DeliveryPlaceInputOptions) {
  const root=element('section',undefined,'delivery-place-input');root.setAttribute('aria-label',options.label);
  const place=new DeliveryPlaceState(root,options);
  const view=mount(DeliveryPlace,{target:root,props:{place,address:options.value?.address??''}});flushSync();
  return {
    element:root,read:place.read,
    searchAddress(){place.searchAddress();flushSync();},
    async showMap(){const opening=place.showMap();flushSync();await opening;flushSync();},
    setValue(next:Place){place.setValue(next);flushSync();},
    destroy(){if(!place.destroy())return;void unmount(view);root.remove();},
  };
}
