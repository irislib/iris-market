import { verifyEvent, type Event as NostrEvent, type VerifiedEvent } from 'nostr-tools';

const encoder = new TextEncoder();
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
// Module-private registry of deeply frozen, sanitized wire events verified in
// this realm. External, mutable, serialized or storage-read objects are never
// members and always undergo full copy + cryptographic verification.
const verified = new WeakMap<VerifiedEvent, number>();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

/** Verify and freeze a clean 7-field wire copy, or reuse an already-frozen verified one. */
export function verifyCleanEvent(input: unknown, maxBytes = 1024 * 1024, maxTags = 10000): VerifiedEvent | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const cached = verified.get(input as VerifiedEvent);
  if (cached !== undefined) {
    const event = input as VerifiedEvent;
    return cached <= maxBytes && event.tags.length <= maxTags ? event : null;
  }
  const raw = input as NostrEvent;
  if (
    !Number.isSafeInteger(raw.kind) ||
    !Number.isSafeInteger(raw.created_at) || raw.created_at < 0 ||
    typeof raw.id !== 'string' || !HEX64.test(raw.id) ||
    typeof raw.pubkey !== 'string' || !HEX64.test(raw.pubkey) ||
    typeof raw.sig !== 'string' || !HEX128.test(raw.sig) ||
    typeof raw.content !== 'string' ||
    !Array.isArray(raw.tags) || raw.tags.length > maxTags
  ) return null;
  const tags: string[][] = new Array(raw.tags.length);
  for (let i = 0; i < raw.tags.length; i++) {
    const tag = raw.tags[i];
    if (!Array.isArray(tag) || tag.length === 0 || !tag.every(v => typeof v === 'string')) return null;
    tags[i] = Object.freeze([...tag]) as unknown as string[];
  }
  const event: NostrEvent = {
    id: raw.id, pubkey: raw.pubkey, created_at: raw.created_at,
    kind: raw.kind, tags: Object.freeze(tags) as unknown as string[][],
    content: raw.content, sig: raw.sig,
  };
  const json = JSON.stringify(event);
  if (json.length > maxBytes) return null;
  const size = utf8Bytes(json);
  if (size > maxBytes || !verifyEvent(event)) return null;
  verified.set(Object.freeze(event) as VerifiedEvent, size);
  return event as VerifiedEvent;
}

/** Exact byte-equivalent comparison against an already-verified wire event. */
export function sameWireEvent(input: unknown, known: NostrEvent): boolean {
  if (input === known) return true;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  try {
    const a = input as NostrEvent;
    if (
      a.id !== known.id || a.pubkey !== known.pubkey || a.kind !== known.kind ||
      a.created_at !== known.created_at || a.sig !== known.sig || a.content !== known.content ||
      !Array.isArray(a.tags) || a.tags.length !== known.tags.length
    ) return false;
    return a.tags.every((at, i) => Array.isArray(at) && at.length === known.tags[i].length && at.every((v, j) => v === known.tags[i][j]));
  } catch {
    return false;
  }
}
