import { listingURL } from './routes.ts';
/** A draft enquiry, never a payment, order or automatic message. */
export function listingEnquiry(listing, href) {
  const url=new URL(listingURL(listing.id,href));
  const buying=listing.side==='request';
  return {label:buying?'Respond':'Buy',draft:`${buying?'I can help with':'I’d like to buy'} “${listing.title}”.\n${url.href}`};
}
