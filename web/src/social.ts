import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure'
import { decode } from 'nostr-tools/nip19'
import { SocialGraph } from 'nostr-social-graph'
import { DEFAULT_RELAYS, validateRelays } from './market.ts'

export interface FollowLookupOptions { relays?: readonly string[]; signal?: AbortSignal; timeoutMs?: number; WebSocketImpl?: typeof WebSocket; now?: () => number }
export interface PublicFollows { pubkey: string; authors: readonly string[] }
interface FollowConnection { socket: WebSocket | null; subscription: string; frames: number; events: number; settled: boolean }

const MAX_EVENT_BYTES = 1024 * 1024
const MAX_FRAME_BYTES = MAX_EVENT_BYTES + 2048
const MAX_TAGS = 10000
const MAX_AUTHORS = 256
const MAX_FRAMES_PER_RELAY = 32
const MAX_EVENTS_PER_RELAY = 8
const encoder = new TextEncoder()
const isKey = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const seconds = () => Math.floor(Date.now() / 1000)

function lookupError(code, message) {
  return Object.assign(new Error(message), { name: 'SocialLookupError', code })
}

/** Accept a public npub or hexadecimal key. Never accept or derive a private key. */
export function normalizePublicKey(input: string): string {
  if (typeof input !== 'string' || input.length > 256) throw lookupError('invalid-key', 'Enter a public npub or hexadecimal key.')
  const value = input.trim()
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase()
  if (/^npub1/i.test(value)) {
    try {
      const decoded = decode(value)
      if (decoded.type === 'npub' && isKey(decoded.data)) return decoded.data
    } catch { /* Malformed public keys are rejected without echoing the input. */ }
  }
  throw lookupError('invalid-key', 'Enter a public npub or hexadecimal key.')
}

function contactList(input: NostrEvent, pubkey: string, now: number) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.kind !== 3 || input.pubkey !== pubkey) return null
  if (!Number.isSafeInteger(input.created_at) || input.created_at < 0 || input.created_at > now + 300) return null
  if (!isKey(input.id) || typeof input.sig !== 'string' || !/^[0-9a-f]{128}$/.test(input.sig)) return null
  if (typeof input.content !== 'string' || !Array.isArray(input.tags)) return null
  if (input.tags.length > MAX_TAGS) throw lookupError('limit', 'This public follow list exceeds the supported size.')
  if (!input.tags.every(tag => Array.isArray(tag) && tag.length > 0 && tag.every(value => typeof value === 'string'))) return null
  // Only wire fields enter verification; a caller's cached verification Symbol
  // cannot authenticate mutated data. No relay hints or contact content is used.
  const event = {
    id: input.id, pubkey: input.pubkey, created_at: input.created_at, kind: input.kind,
    tags: input.tags.map(tag => [...tag]), content: input.content, sig: input.sig,
  }
  if (encoder.encode(JSON.stringify(event)).length > MAX_EVENT_BYTES) throw lookupError('limit', 'This public follow list exceeds the supported size.')
  if (!verifyEvent(event)) return null
  const graph = new SocialGraph(pubkey)
  if (!graph.handleEvent(event, true, Infinity)) return null
  const authors = [...graph.getFollowedByUser(pubkey)].sort()
  if (authors.length > MAX_AUTHORS) throw lookupError('limit', 'This profile follows more than 256 authors, beyond the current filter limit.')
  return { authors, createdAt: event.created_at, id: event.id }
}

/**
 * Read direct public follows from the latest verified kind-3 event observed in
 * this bounded lookup. Relays can omit data; this does not prove global freshness.
 *
 * Only an authenticated empty list returns authors: []. Missing/unavailable
 * data, aborts and exceeded bounds reject: callers must retain the unfiltered
 * feed and show the error, rather than converting lookup failures into [].
 *
 * No signing, authentication, browsing history, relay hints or second-hop crawl.
 * WebSocketImpl and now are injectable for deterministic, offline tests.
 */
export async function fetchFollows(publicKey: string, {
  relays = DEFAULT_RELAYS, signal, timeoutMs = 8000,
  WebSocketImpl = globalThis.WebSocket, now = seconds,
}: FollowLookupOptions = {}): Promise<PublicFollows> {
  const pubkey = normalizePublicKey(publicKey)
  const servers = validateRelays(relays)
  if (!servers.length) throw lookupError('unavailable', 'Choose a message server to look up public follows.')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw lookupError('invalid-options', 'Follow lookup timeout must be between 1 and 30000 milliseconds.')
  if (typeof WebSocketImpl !== 'function') throw lookupError('unavailable', 'This browser cannot connect to message servers.')
  if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw lookupError('invalid-options', 'Invalid cancellation signal.')
  if (signal?.aborted) throw new DOMException('Public follows lookup cancelled.', 'AbortError')

  return new Promise<PublicFollows>((resolve, reject) => {
    const connections: FollowConnection[] = []
    let latest = null, pending = 0, completed = 0, starting = true, finished = false
    const dispose = connection => {
      const socket = connection.socket
      if (!socket) return
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      try {
        if (socket.readyState === 1) socket.send(JSON.stringify(['CLOSE', connection.subscription]))
      } catch { /* Transport may have closed already. */ }
      try { socket.close() } catch { /* Closing is best-effort after handlers detach. */ }
    }
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      for (const connection of connections) dispose(connection)
      if (error) reject(error)
      else if (latest && completed) resolve(Object.freeze({ pubkey, authors: Object.freeze(latest.authors) }))
      else reject(lookupError('unavailable', completed ? 'No verified public follow list was found.' : 'Could not load this profile’s public follows.'))
    }
    const settle = (connection, eose = false) => {
      if (finished || connection.settled) return
      connection.settled = true
      if (eose) completed++
      pending--
      dispose(connection)
      if (!starting && pending === 0) finish()
    }
    const abort = () => finish(new DOMException('Public follows lookup cancelled.', 'AbortError'))
    const timer = setTimeout(() => {
      if (latest && completed) finish()
      else finish(lookupError('timeout', 'Public follows lookup timed out.'))
    }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })

    for (const url of servers) {
      if (finished) break
      const connection: FollowConnection = { socket: null, subscription: `market-follows-${Math.random().toString(36).slice(2, 14)}`, frames: 0, events: 0, settled: false }
      connections.push(connection)
      pending++
      let socket
      try { socket = new WebSocketImpl(url) }
      catch { settle(connection); continue }
      connection.socket = socket
      const active = () => !finished && !connection.settled
      socket.onopen = () => {
        if (!active()) return
        try { socket.send(JSON.stringify(['REQ', connection.subscription, { kinds: [3], authors: [pubkey], limit: 1 }])) }
        catch { settle(connection) }
      }
      socket.onmessage = ({ data }) => {
        if (!active()) return
        if (++connection.frames > MAX_FRAMES_PER_RELAY || typeof data !== 'string' ||
            data.length > MAX_FRAME_BYTES || encoder.encode(data).length > MAX_FRAME_BYTES) {
          finish(lookupError('limit', 'The public follow lookup exceeded its response limit.')); return
        }
        let frame
        try { frame = JSON.parse(data) } catch { return }
        if (!Array.isArray(frame) || frame[1] !== connection.subscription) return
        if (frame[0] === 'EOSE') { settle(connection, true); return }
        if (frame[0] === 'CLOSED') { settle(connection); return }
        if (frame[0] !== 'EVENT' || frame.length !== 3) return
        if (++connection.events > MAX_EVENTS_PER_RELAY) {
          finish(lookupError('limit', 'The public follow lookup exceeded its event limit.')); return
        }
        try {
          const candidate = contactList(frame[2], pubkey, now())
          if (candidate && (!latest || candidate.createdAt > latest.createdAt ||
              (candidate.createdAt === latest.createdAt && candidate.id < latest.id))) latest = candidate
        } catch (error) {
          if (error?.code === 'limit') finish(error)
          // Invalid untrusted records are ignored; they never replace a verified list.
        }
      }
      socket.onerror = socket.onclose = () => { if (active()) settle(connection) }
    }
    starting = false
    if (!finished && signal?.aborted) abort()
    else if (!finished && pending === 0) finish()
  })
}
