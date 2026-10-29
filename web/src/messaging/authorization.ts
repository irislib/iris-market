// Adapted from Iris Chat at cc68f2fa6ac9396faed732bc94e3b511f09d834f.
// https://github.com/irislib/iris-chat/blob/cc68f2fa6ac9396faed732bc94e3b511f09d834f/src/lib/signerAuthorization.ts
import { AppKeys } from "nostr-double-ratchet";
import { generateSecretKey, getEventHash, getPublicKey, verifyEvent } from "nostr-tools";
import type { Event, VerifiedEvent } from 'nostr-tools';
import { signerRelayUrls } from "./remote-signer.ts";
const LOOKUP_TIMEOUT = 10_000;
const MAX_EVENTS = 1024;
const HEX_KEY = /^[a-f0-9]{64}$/;
function check(signal) {
  signal.throwIfAborted();
}
// Reverify signed fields without trusting a caller-owned verification cache symbol.
function canonicalEvent(event:Event):VerifiedEvent {
  const canonical = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig
  };
  if(!verifyEvent(canonical))throw new Error('Invalid signer signature.');
  return canonical as VerifiedEvent;
}
function signerRosterHeads(events, owner) {
  const candidates = /* @__PURE__ */ new Map();
  let latest = 0;
  for (const incoming of events) {
    if (incoming.pubkey !== owner || incoming.kind !== 37368 || !incoming.tags.some((tag) => tag[0] === "type" && tag[1] === "app_keys_roster_snapshot")) continue;
    const event = canonicalEvent(incoming);
    const appKeys = AppKeys.fromEvent(event as VerifiedEvent);
    if (event.created_at > Math.floor(Date.now() / 1e3) + 300 || appKeys.getAllDevices().length > 64) throw new Error("Invalid device list from message server.");
    for (const tag of event.tags.filter((tag2) => tag2[0] === "device")) {
      if (!/^[a-f0-9]{64}$/.test(tag[1]) || !/^\d+$/.test(tag[2]) || !Number.isSafeInteger(Number(tag[2]))) throw new Error("Invalid device list from message server.");
    }
    if (event.created_at < latest) continue;
    if (event.created_at > latest) {
      candidates.clear();
      latest = event.created_at;
    }
    candidates.set(event.id, event);
  }
  return [...candidates.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function selectSignerRoster(events, owner) {
  const heads = signerRosterHeads(events, owner);
  if (heads.length > 1) throw new Error("Conflicting device lists. Try again later.");
  return heads[0] ?? null;
}
async function fetchSignerRosterHeads(owner, urls, signal, runtime) {
  check(signal);
  const result = await runtime.query([{ kinds: [37368], authors: [owner], limit: MAX_EVENTS }], {
    relays: signerRelayUrls(urls),
    sources: [],
    cache: "network-only",
    localEcho: false,
    // Concurrent signed roster heads must remain visible so conflict checks cannot
    // mistake the cache's deterministic replaceable winner for server consensus.
    includeSuperseded: true,
    deadline: Date.now() + LOOKUP_TIMEOUT,
    signal
  });
  check(signal);
  if (result.events.length >= MAX_EVENTS) throw new Error("Device list is too large.");
  const heads = signerRosterHeads(result.events, owner);
  if (!result.complete && (!result.sources.some((source) => source.complete) || !heads.length)) {
    throw new Error("Could not check all message servers. Try again.");
  }
  return heads;
}
async function fetchSignerRoster(owner, urls, signal, runtime) {
  const heads = await fetchSignerRosterHeads(owner, urls, signal, runtime);
  if (heads.length > 1) throw new Error("Conflicting device lists. Try again later.");
  return heads[0] ?? null;
}
function prepareSignerAuthorization(owner, device, previous) {
  if (!HEX_KEY.test(owner) || !HEX_KEY.test(device) || previous && previous.pubkey !== owner) throw new Error("Invalid device authorization.");
  const now = Math.floor(Date.now() / 1e3);
  const appKeys = previous ? AppKeys.fromEvent(canonicalEvent(previous)) : new AppKeys();
  const createdAt = Math.max(now, (previous?.created_at ?? 0) + 1);
  if (createdAt > now + 300) throw new Error("Device list is dated too far ahead. Try again later.");
  appKeys.addDevice({ identityPubkey: device, createdAt: now });
  if (appKeys.getAllDevices().length > 64) throw new Error("Too many linked devices.");
  // Let AppKeys generate the current snapshot format and a fresh profile UUID.
  // Device labels remain local; they are never copied into a public authorization.
  const event = appKeys.getEvent({ ownerPubkey: owner, createdAt });
  event.pubkey = owner;
  if (JSON.stringify(event).length > 32 * 1024 - 256) throw new Error("Device list is too large.");
  return event;
}
function validateSignerAuthorization(expected, incoming) {
  const event = canonicalEvent(incoming);
  if (event.pubkey !== expected.pubkey || event.kind !== expected.kind || event.created_at !== expected.created_at || event.content !== expected.content || JSON.stringify(event.tags) !== JSON.stringify(expected.tags) || event.id !== getEventHash(expected)) throw new Error("Signer changed the device authorization. Try again.");
  if (!verifyEvent(event)) throw new Error("Invalid signer signature.");
  AppKeys.fromEvent(event as VerifiedEvent);
  return event as VerifiedEvent;
}
async function authorizeSignerDevice(options) {
  const { owner, relays, signal, runtime } = options;
  if (options.deviceSecret !== undefined && (!(options.deviceSecret instanceof Uint8Array) || options.deviceSecret.length !== 32)) throw new Error("Invalid saved device key.");
  // A retry owns a clone: failure must not erase the caller's durably saved key.
  const deviceSecret = options.deviceSecret?.slice() ?? generateSecretKey();
  try {
    const device = getPublicKey(deviceSecret);
    const previous = options.freshOwner ? null : await fetchSignerRoster(owner, relays, signal, runtime);
    if (previous && AppKeys.fromEvent(previous).getDevice(device)) {
      options.onAuthorized?.(previous, device);
      check(signal);
      await options.onPrepared?.({ event: previous, deviceSecret });
      check(signal);
      options.onCommitting?.();
      return { event: previous, deviceSecret };
    }
    const expected = prepareSignerAuthorization(owner, device, previous);
    const request = { ...expected, tags: expected.tags.map(tag => [...tag]) };
    const event = validateSignerAuthorization(expected, await options.signEvent(request));
    options.onAuthorized?.(event, getPublicKey(deviceSecret));
    check(signal);
    // Persist a copied/encrypted key and this exact proof before servers can accept it.
    await options.onPrepared?.({ event, deviceSecret });
    check(signal);
    const current = options.freshOwner ? null : await fetchSignerRoster(owner, relays, signal, runtime);
    if (current?.id !== previous?.id) throw new Error("Your device list changed. Sign in again.");
    check(signal);
    // Once publication starts, cancellation must not discard an approved device key.
    options.onCommitting?.();
    const receipt = await runtime.publish(event, { relays: signerRelayUrls(relays), sources: [], requireAck: true, queue: false, localEcho: false, signal });
    if (!receipt.remoteAccepted) throw new Error("Could not save device authorization. Try again.");
    return { event, deviceSecret };
  } catch (error) {
    deviceSecret.fill(0);
    throw error;
  }
}
export {
  authorizeSignerDevice,
  fetchSignerRoster,
  fetchSignerRosterHeads,
  prepareSignerAuthorization,
  selectSignerRoster,
  validateSignerAuthorization
};
