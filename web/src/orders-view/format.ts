import { decode } from 'nostr-tools/nip19';
import { normalizePublicKey } from '../social.ts';

export const terminal = order => ['delivered', 'cancelled'].includes(order.status);
export const statuses = { requested: 'Requested', accepted: 'Accepted', 'in-transit': 'On the way', delivered: 'Delivered', cancelled: 'Cancelled' };
export const date = value => Number.isFinite(value) ? new Date(value * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
export const dateTime = value => Number.isFinite(value) ? new Date(value * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
export const localDateTime = value => { if (!Number.isFinite(value)) return ''; const at = new Date(value * 1000); return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export const courierKey = (input:string) => {
  try {
    let value = input.trim().replace(/^nostr:/i, '');
    if (/^https?:\/\//i.test(value)) { const url = new URL(value); value = url.searchParams.get('profile') || url.pathname.split('/').filter(Boolean).pop() || ''; }
    if (value.startsWith('nprofile1')) { const profile = decode(value as `nprofile1${string}`); if (profile.type === 'nprofile') value = profile.data.pubkey; }
    return normalizePublicKey(value);
  } catch { throw new Error('Enter a valid public profile link or user ID.'); }
};
export const dark = () => document.documentElement.dataset.appearance === 'dark' || (document.documentElement.dataset.appearance !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);

/** Only secure carrier links without embedded credentials are shown. */
export function trackingLink(tracking?:string):string|undefined {
  if (!tracking) return;
  try { const url = new URL(tracking); if (url.protocol === 'https:' && !url.username && !url.password) return url.href; } catch {}
}
