import { deploymentBase } from './asset-url.ts';
/** A draft enquiry, never a payment, order or automatic message. */
export function listingEnquiry(listing, href) {
  const url=deploymentBase(href);url.searchParams.set('listing',listing.id);
  const buying=listing.side==='request';
  return {label:buying?'Respond':'Buy',draft:`${buying?'I can help with':'I’d like to buy'} “${listing.title}”.\n${url.href}`};
}
