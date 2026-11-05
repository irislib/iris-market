export const DEFAULT_RELAYS = Object.freeze(['wss://temp.iris.to', 'wss://vault.iris.to', 'wss://relay.damus.io', 'wss://relay.snort.social', 'wss://relay.primal.net', 'wss://nos.lol']);

/** Fixed public discovery services belong only to the shipped relay policy. */
export function usesDefaultPublicRelays(relays: readonly string[]): boolean {
  try {
    const selected = new Set(relays.map(url => new URL(url).href));
    return selected.size === DEFAULT_RELAYS.length && DEFAULT_RELAYS.every(url => selected.has(new URL(url).href));
  } catch { return false; }
}
