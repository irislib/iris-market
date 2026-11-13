import {flushNow} from './account/flush.ts';
import {mount} from 'svelte';
import type {MarketListing} from './market.ts';
import type {merchantNotices} from './messaging/merchant-notice.ts';
import SellerNotice from './account/SellerNotice.svelte';

export function canNotifySeller(listing:(MarketListing & {externalOrder?:unknown})|undefined, preview:boolean, owner?:string) {
  return !preview && !!listing?.author && listing.rawEvent?.pubkey === listing.author
    && !listing.externalOrder && listing.side === 'offer' && listing.status === 'active'
    && (!listing.expiration || listing.expiration > Date.now()/1000) && listing.author !== owner;
}

/** The returned root moves between listing renders; the component lives with it. */
export function sellerNoticeControl(merchant:string, notices:Pick<ReturnType<typeof merchantNotices>,'status'|'queue'>, stillEligible:()=>boolean) {
  const fragment = document.createDocumentFragment();
  const control = mount(SellerNotice, {target: fragment as unknown as Element, props: {merchant, notices, stillEligible}});
  flushNow();
  const root = fragment.firstElementChild as HTMLElement;
  return {root, show: (state:string) => { control.show(state); flushNow(); }};
}
