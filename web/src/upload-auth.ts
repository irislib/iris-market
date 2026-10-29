import type { EventTemplate } from 'nostr-tools/pure';
/** Restrict kind24242 to one short-lived approval for exactly one public upload. */
export function validateUploadAuthorization(event: EventTemplate, expectedHash?: string, now = Math.floor(Date.now() / 1000)) {
  if (!event || event.kind !== 24242 || !Number.isSafeInteger(event.created_at) || (event.created_at < now - 300 || event.created_at > now + 30) || !Array.isArray(event.tags) || event.tags.length !== 3 || event.tags.some(tag => !Array.isArray(tag) || tag.length !== 2)) throw new Error('Invalid file upload approval.');
  const values = new Map<string, string>(event.tags.map(tag => [tag[0], tag[1]]));
  const hash = values.get('x'), expiration = values.get('expiration');
  if (values.size !== 3 || values.get('t') !== 'upload' || !/^[a-f0-9]{64}$/.test(hash || '') || expectedHash && hash !== expectedHash || !/^\d{1,12}$/.test(expiration || '') || Number(expiration) <= now || Number(expiration) > event.created_at + 300 || event.content !== `upload ${hash}`) throw new Error('Invalid file upload approval.');
  return event;
}
