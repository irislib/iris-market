import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface NotificationItem { id: string; mine?: boolean; createdAt?: number }
export interface NotificationStream { id: string; items: NotificationItem[] }
export interface NotificationConversation { pubkey: string; messages: Array<NotificationItem & {orderId?: string}> }
interface ReadMarker { at: number; ids: string[] }
interface MarkerFile { version: 1; streams: Record<string, ReadMarker> }
type MarkerStorage = Pick<Storage, 'getItem' | 'setItem'>;
const MAX_STREAMS = 64, MAX_READ_IDS = 1000, MAX_STORAGE_BYTES = 2_500_000;
const encoder = new TextEncoder();
const hash = (value: string) => bytesToHex(sha256(encoder.encode(value))).slice(0, 32);
const digest = /^[a-f0-9]{32}$/;
const browserStorage = (): MarkerStorage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };

export function conversationNotifications(conversations: NotificationConversation[] = []): NotificationStream[] {
  return conversations.map(conversation => ({ id: conversation.pubkey, items: conversation.messages.map(({id,mine,createdAt}) => ({id,mine,createdAt})) }));
}
/** Only authenticated incoming summaries count. GPS updates are not chat messages. */
export function orderNotifications(conversations: NotificationConversation[] = [], orders: Array<{id:string;archived?:boolean}> = []): NotificationStream[] {
  const streams = new Map(orders.filter(order => !order.archived).map(order => [order.id, [] as NotificationItem[]]));
  for (const conversation of conversations) for (const {id,mine,createdAt,orderId} of conversation.messages) {
    if (orderId && streams.has(orderId)) streams.get(orderId).push({id,mine,createdAt});
  }
  return [...streams].map(([id,items]) => ({id,items}));
}

/** Local read receipts contain only profile-scoped hashes and timestamps, never message content. */
export function createUnreadTracker({ kind, storage = browserStorage(), now = Date.now, onUnread = (_count: number) => {} }: {kind:'messages'|'orders';storage?:MarkerStorage;now?:()=>number;onUnread?:(count:number)=>void}) {
  let profile: string | null = null, key = '', markers: MarkerFile = {version:1,streams:{}}, count = -1;
  let streams = new Map<string, string[]>();
  const streamHash = (id: string) => hash(`${profile}:${kind}:stream:${id}`);
  const itemHash = (id: string) => hash(`${profile}:${kind}:item:${id}`);
  function unreadHash(id: string) {
    const read = new Set(markers.streams[id]?.ids || []);
    return (streams.get(id) || []).filter(item => !read.has(item)).length;
  }
  function report() {
    const next = [...streams.keys()].filter(id => unreadHash(id) > 0).length;
    if (next !== count) { count = next; onUnread(next); }
  }
  function load(): MarkerFile {
    try {
      const raw = storage?.getItem(key); if (!raw || raw.length > MAX_STORAGE_BYTES) return {version:1,streams:{}};
      const value = JSON.parse(raw);
      if (value?.version !== 1 || !value.streams || typeof value.streams !== 'object' || Array.isArray(value.streams)) return {version:1,streams:{}};
      const entries = Object.entries(value.streams as Record<string, ReadMarker>).filter(([id, marker]: [string, ReadMarker]) => digest.test(id) && marker && Number.isFinite(marker.at) && Array.isArray(marker.ids) && marker.ids.length <= MAX_READ_IDS && marker.ids.every(value => typeof value === 'string' && digest.test(value)))
        .sort(([,a]:[string,ReadMarker],[,b]:[string,ReadMarker]) => b.at-a.at).slice(0,MAX_STREAMS);
      return {version:1,streams:Object.fromEntries(entries)};
    } catch { return {version:1,streams:{}}; }
  }
  function save() {
    markers.streams = Object.fromEntries(Object.entries(markers.streams).sort(([,a],[,b]) => b.at-a.at).slice(0,MAX_STREAMS));
    try { storage?.setItem(key, JSON.stringify(markers)); } catch { /* Keep the session usable when local storage is full or disabled. */ }
  }
  function read(id: string) {
    if (!profile) return;
    const stream = streamHash(id), incoming = streams.get(stream);
    if (!incoming?.length || !unreadHash(stream)) return;
    const ids = [...new Set([...(markers.streams[stream]?.ids || []), ...incoming])].slice(-MAX_READ_IDS);
    markers.streams[stream] = {at:now(),ids}; save(); report();
  }
  return {
    update(owner: string | null | undefined, values: NotificationStream[], visibleId?: string | null) {
      const next = owner || null;
      if (next !== profile) { profile=next; key=next?`iris-market-unread-v1:${kind}:${hash(next)}`:''; markers=next?load():{version:1,streams:{}}; }
      streams = new Map();
      if (profile) for (const value of values) {
        const ids = [...new Set(value.items.filter(item => !item.mine && typeof item.id==='string' && item.id.length>0 && item.id.length<=256).map(item=>itemHash(item.id)))];
        if (ids.length) streams.set(streamHash(value.id), ids);
      }
      if (visibleId) read(visibleId);
      report();
    },
    read,
    unread: (id: string) => profile ? unreadHash(streamHash(id)) : 0,
    count: () => Math.max(0,count),
  };
}

/** An open routed page counts as read only while it is foreground and uncovered. */
export function readingSurface(surface: Element & {open:boolean}, doc: Pick<Document, 'visibilityState'|'hasFocus'|'querySelectorAll'> = document): boolean {
  if (!surface.open || doc.visibilityState === 'hidden' || !doc.hasFocus()) return false;
  const dialogs = [...doc.querySelectorAll('dialog[open]')];
  return !dialogs.length || dialogs.at(-1) === surface;
}
