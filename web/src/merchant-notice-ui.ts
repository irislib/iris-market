import type {MarketListing} from './market.ts';
import {element} from './dom.ts';
import {noticeMessage, type merchantNotices} from './messaging/merchant-notice.ts';

export function canNotifySeller(listing:(MarketListing & {externalOrder?:unknown})|undefined, preview:boolean, owner?:string) {
  return !preview && !!listing?.author && listing.rawEvent?.pubkey === listing.author
    && !listing.externalOrder && listing.side === 'offer' && listing.status === 'active'
    && (!listing.expiration || listing.expiration > Date.now()/1000) && listing.author !== owner;
}

export function sellerNoticeControl(merchant:string, notices:ReturnType<typeof merchantNotices>, stillEligible:()=>boolean) {
  const root = element('div', undefined, 'seller-notice');
  const button = element('button','Notify seller anonymously','button secondary');
  const copy = element('p','Sends “'+noticeMessage+'”','small muted');
  const feedback = element('p','','small muted');
  feedback.setAttribute('role','status');
  button.type = 'button';
  root.hidden = true;
  root.append(button,copy,feedback);
  let revision = 0;
  function show(state:string) {
    revision++;
    root.hidden = state === 'unavailable';
    button.hidden = !['available','no-inbox'].includes(state);
    button.disabled = state !== 'available';
    copy.hidden = state !== 'available';
    feedback.textContent = state === 'sent' ? 'Notice accepted by the seller’s inbox relay.' : state === 'no-inbox' ? 'This seller hasn’t published an inbox for anonymous notices.' : state === 'queued' ? 'Anonymous notice queued.' : '';
  }
  const initial = revision;
  void notices.status(merchant).then(s => {if (revision === initial) show(s);}).catch(()=>{});
  button.onclick = async () => {
    if (button.disabled) return;
    if (!stillEligible()) { show('unavailable'); return; }
    button.disabled = true;
    try { show(await notices.queue(merchant)); }
    catch { feedback.textContent = 'Could not save the notice. Try again.'; button.disabled = false; }
  };
  return {root,show};
}
