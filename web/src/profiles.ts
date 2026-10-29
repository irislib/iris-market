/*!
 * Social relationship presentation adapted from iris-chat-rs
 * core/src/core/social_connection.rs. MIT License, Copyright (c) 2026 lauri000.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure'
import { fallbackIdentityName, getProfileName } from './shared/iris-kit/profile.ts'
import { SocialGraph } from 'nostr-social-graph'
import {createProfileHeadCache} from './profile-cache.ts'
import type { Filter } from 'nostr-tools'
import { getPublicRuntime, type PublicEventRuntime } from './nostr-runtime.ts'
import { loadGraphBootstrap } from './graph-bootstrap.ts'
import { DEFAULT_RELAYS, validateRelays } from './market.ts'
import { normalizePublicKey } from './social.ts'

export interface ProfileFilter extends Filter { kinds?: number[]; authors?: string[]; '#p'?: string[]; limit?: number }
export interface ProfileQueryOptions { relays?: readonly string[]; signal?: AbortSignal; WebSocketImpl?: typeof WebSocket; runtime?: PublicEventRuntime; now?: () => number; timeoutMs?: number }
export interface ProfileQueryResult { events: NostrEvent[]; completed: number; limited: boolean; partial: boolean }
export interface CurationOptions extends ProfileQueryOptions { contextPubkey?: string; targetAuthors?: string[]; bootstrapLoader?: typeof loadGraphBootstrap }
export interface PublicProfile { pubkey: string; eventId?: string; createdAt?: number; name: string; about: string; pictureUrl: string | null; website: string | null; nip05: string; metadataFound: boolean }
interface ProfileConnection { id: string; socket: WebSocket | null; settled: boolean; frames: number }
interface FollowRecord { event: NostrEvent; follows: string[] | null }
interface ProfileRecord { event: NostrEvent; profile: PublicProfile | null }
export interface SocialConnection { distance: number | null; badge: string | null; knownFollowers: string[]; knownFollowerCount: number; description: string; partial: boolean }
interface GraphCoverage { partial: boolean; rootLoaded: boolean; directFollows: number | null; secondHopRequested: number; secondHopLoaded: number; completedRelays: number; bootstrap: unknown; warnings: string[] }
export interface CurationContext {
  contextPubkey: string; contextLabel: string; relationFor: (pubkey: string) => SocialConnection
  rankRelationFor: (pubkey: string) => { distance: number | null; knownFollowerCount: number; source: string; stale?: boolean; partial: boolean }
  coverage: GraphCoverage; graph: SocialGraph | null; lists: Map<string, FollowRecord>
}
interface ProfileStore { profiles: Map<string, ProfileRecord>; follows: Map<string, FollowRecord>; contexts: Map<string, {result: CurationContext; loadedAt: number}> }

// Established visitor root from iris-client/src/utils/socialGraph.ts.
export const DEFAULT_SOCIAL_GRAPH_ROOT = '336f319763657d6b0e65a5b5876719e8c8dcdcf9396852be71ee26b73368b29b'
export const DEFAULT_SOCIAL_GRAPH_LABEL = 'Sirius Business'
export const PROFILE_LIMITS = Object.freeze({ follows: 4096, display: 256, secondHop: 32, inbound: 64, metadata: 64, eventBytes: 1024 * 1024, queryBytes: 6 * 1024 * 1024, queryEvents: 512, timeoutMs: 6000, settleGraceMs: 500 })
const encoder = new TextEncoder()
const seconds = () => Math.floor(Date.now() / 1000)
const isKey = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const newer = (a, b) => !b || a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id)
const abortError = () => new DOMException('Profile lookup cancelled.', 'AbortError')
const caches = new Map<string, ProfileStore>()
const metadataObservers = new Map<string, Set<(profile: PublicProfile) => void>>()
const relayKey = (relays:readonly string[]) => JSON.stringify(validateRelays(relays))
let startupHeads:ReturnType<typeof createProfileHeadCache>|undefined,headFlush:ReturnType<typeof setTimeout>|undefined;
function profileHeads(){
  if(startupHeads)return startupHeads;
  try{const storage=globalThis.window?.localStorage;if(storage)startupHeads=createProfileHeadCache({storage,validate:event=>verifyProfileRecord(event)});}catch{/* Memory and shared worker cache still work. */}
  return startupHeads;
}
function rememberProfile(event:NostrEvent){
  try{if(profileHeads()?.observe(event)&&!headFlush)headFlush=setTimeout(()=>{headFlush=undefined;startupHeads?.flush();},250);}catch{/* Oversized profile heads stay in the worker cache. */}
}

/** Observe verified cache changes without opening another network subscription. */
export function subscribeProfileMetadata(listener:(profile:PublicProfile)=>void, {relays=DEFAULT_RELAYS}:{relays?:readonly string[]}={}) {
  const key=relayKey(relays), listeners=metadataObservers.get(key)??new Set();metadataObservers.set(key,listeners);listeners.add(listener);
  return ()=>{listeners.delete(listener);if(!listeners.size)metadataObservers.delete(key);};
}

export function profileLabel(pubkey) {
  return fallbackIdentityName(normalizePublicKey(pubkey))
}
const cleanText = (value, max) => typeof value === 'string' ? Array.from(value.trim()).slice(0, max).join('') : ''
function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : null
  } catch { return null }
}

/** Copies wire fields before verification, ignoring mutable cached-verification symbols. */
export function verifyProfileRecord(input: NostrEvent, { now = seconds() } = {}) {
  if (!input || ![0, 3].includes(input.kind) || !isKey(input.id) || !isKey(input.pubkey) || typeof input.sig !== 'string' || !/^[0-9a-f]{128}$/.test(input.sig)) throw new Error('Invalid public profile record')
  if (!Number.isSafeInteger(input.created_at) || input.created_at < 0 || input.created_at > now + 300 || typeof input.content !== 'string') throw new Error('Invalid public profile timestamp or content')
  if (!Array.isArray(input.tags) || input.tags.length > 10000 || !input.tags.every(tag => Array.isArray(tag) && tag.length && tag.every(value => typeof value === 'string'))) throw new Error('Invalid public profile tags')
  const event = { id: input.id, pubkey: input.pubkey, kind: input.kind, created_at: input.created_at, content: input.content, tags: input.tags.map(tag => [...tag]), sig: input.sig }
  if (encoder.encode(JSON.stringify(event)).length > (event.kind === 0 ? 65536 : PROFILE_LIMITS.eventBytes) || !verifyEvent(event)) throw new Error('Invalid or oversized public profile record')
  return event
}

export function parseProfileEvent(input: NostrEvent, options?: {now?: number}): PublicProfile {
  const event = verifyProfileRecord(input, options)
  if (event.kind !== 0) throw new Error('Expected profile metadata')
  let data
  try { data = JSON.parse(event.content) } catch { throw new Error('Invalid profile metadata') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid profile metadata')
  return Object.freeze({ pubkey: event.pubkey, eventId: event.id, createdAt: event.created_at,
    name: cleanText(getProfileName(data), 100) || profileLabel(event.pubkey),
    about: cleanText(data.about, 2000), pictureUrl: safeUrl(data.picture), website: safeUrl(data.website),
    // A self-declared address is text only; it is never an identity-verification badge.
    nip05: cleanText(data.nip05, 200), metadataFound: true })
}

export function parseFollowEvent(input: NostrEvent, options?: {now?: number}): FollowRecord {
  const event = verifyProfileRecord(input, options)
  if (event.kind !== 3) throw new Error('Expected a public follow list')
  const follows = [...new Set(event.tags.filter(tag => tag[0] === 'p' && isKey(tag[1]) && tag[1] !== event.pubkey).map(tag => tag[1]))].sort()
  if (follows.length > PROFILE_LIMITS.follows) throw new Error('This follow list exceeds the supported size')
  return { event, follows }
}

function matches(event: NostrEvent, filter: ProfileFilter) {
  return (!filter.kinds || filter.kinds.includes(event.kind)) && (!filter.authors || filter.authors.includes(event.pubkey)) &&
    (!filter['#p'] || event.tags.some(tag => tag[0] === 'p' && filter['#p'].includes(tag[1])))
}

/** Bounded anonymous reads only. EOSE starts a short reply grace, not proof of global completeness. */
export function queryProfileRecords(filters: ProfileFilter[], { relays = DEFAULT_RELAYS, signal, WebSocketImpl, runtime, now = seconds, timeoutMs = PROFILE_LIMITS.timeoutMs }: ProfileQueryOptions = {}): Promise<ProfileQueryResult> {
  const servers = validateRelays(relays)
  if (!servers.length || (WebSocketImpl !== undefined && typeof WebSocketImpl !== 'function')) return Promise.reject(new Error('Profile servers are unavailable'))
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return Promise.reject(new Error('Invalid profile lookup timeout'))
  if (signal?.aborted) return Promise.reject(abortError())
  if (WebSocketImpl === undefined || runtime) return queryWorkerProfileRecords(filters, runtime ?? getPublicRuntime(servers), { signal, now, timeoutMs, relays:servers })
  return new Promise<ProfileQueryResult>((resolve, reject) => {
    const connections: ProfileConnection[] = [], winners = new Map<string, NostrEvent>()
    let finished = false, pending = servers.length, completed = 0, bytes = 0, events = 0, limited = false, graceTimer = null
    const close = connection => {
      const socket = connection.socket
      if (!socket) return
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      try { if (socket.readyState === 1) socket.send(JSON.stringify(['CLOSE', connection.id])); socket.close() } catch {}
    }
    const finish = (error?: Error) => {
      if (finished) return
      finished = true; clearTimeout(timer); clearTimeout(graceTimer); signal?.removeEventListener('abort', aborted)
      connections.forEach(close)
      if (error) reject(error)
      else resolve({ events: [...winners.values()], completed, limited, partial: true })
    }
    const aborted = () => finish(abortError())
    const settle = (connection, eose) => {
      if (finished || connection.settled) return
      connection.settled = true; close(connection); if (eose) completed++
      if (--pending === 0) finish(completed ? null : new Error('Could not load public profile records'))
      // Collect nearby replies, but do not let a stalled relay hold every
      // profile phase open. Later EOSEs never extend this first-success grace.
      else if (eose && graceTimer === null) graceTimer = setTimeout(() => finish(), PROFILE_LIMITS.settleGraceMs)
    }
    const timer = setTimeout(() => finish(completed || winners.size ? null : new Error('Profile lookup timed out')), timeoutMs)
    signal?.addEventListener('abort', aborted, { once: true })
    for (const url of servers) {
      if (finished) break
      const connection: ProfileConnection = { id: `profile-${Math.random().toString(36).slice(2, 12)}`, socket: null, settled: false, frames: 0 }
      connections.push(connection)
      let socket
      try { socket = new WebSocketImpl(url); connection.socket = socket } catch { settle(connection, false); continue }
      socket.onopen = () => {
        if (finished || connection.settled) return
        try { socket.send(JSON.stringify(['REQ', connection.id, ...filters])) } catch { settle(connection, false) }
      }
      socket.onmessage = ({ data }) => {
        if (finished || connection.settled || typeof data !== 'string') return
        if (data.length > PROFILE_LIMITS.eventBytes + 2048) { limited = true; finish(); return }
        bytes += encoder.encode(data).length
        if (bytes > PROFILE_LIMITS.queryBytes || ++connection.frames > 1024) { limited = true; finish(); return }
        let frame
        try { frame = JSON.parse(data) } catch { return }
        if (!Array.isArray(frame) || frame[1] !== connection.id) return
        if (frame[0] === 'EOSE') { settle(connection, true); return }
        if (frame[0] === 'CLOSED') { settle(connection, false); return }
        if (frame[0] !== 'EVENT' || frame.length !== 3) return
        if (++events > PROFILE_LIMITS.queryEvents) { limited = true; finish(); return }
        try {
          const event = verifyProfileRecord(frame[2], { now: now() })
          if (!filters.some(filter => matches(event, filter))) return
          const coordinate = `${event.kind}:${event.pubkey}`
          if (newer(event, winners.get(coordinate))) { winners.set(coordinate, event); if(event.kind===0)cacheProfileMetadata(event,{relays:servers,now:now()}); }
        } catch { /* Untrusted or oversized events do not enter the record cache. */ }
      }
      socket.onerror = socket.onclose = () => settle(connection, false)
    }
  })
}

async function queryWorkerProfileRecords(filters:ProfileFilter[], runtime:PublicEventRuntime, {signal,now,timeoutMs,relays}:ProfileQueryOptions):Promise<ProfileQueryResult> {
  // A finite shared subscription streams cache/network metadata immediately.
  // Awaiting query() would hold usable names until all sources finish history.
  return new Promise((resolve,reject)=>{
    const winners=new Map<string,NostrEvent>();let bytes=0,frames=0,limited=false,finished=false,completed=0;
    let subscription:ReturnType<PublicEventRuntime['subscribe']>|undefined,grace:ReturnType<typeof setTimeout>|undefined;
    const finish=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(grace);signal?.removeEventListener('abort',abort);subscription?.close();if(error)reject(error);else resolve({events:[...winners.values()],completed,limited,partial:true});};
    const abort=()=>finish(abortError());
    const timer=setTimeout(()=>finish(winners.size||completed?undefined:new Error('Profile lookup timed out')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    try { subscription=runtime.subscribe(filters,{
      onEvent(raw){
        if(finished)return;
        bytes+=encoder.encode(JSON.stringify(raw)).length;
        if(++frames>PROFILE_LIMITS.queryEvents||bytes>PROFILE_LIMITS.queryBytes){limited=true;finish();return;}
        try{
          const event=verifyProfileRecord(raw,{now:now()});if(!filters.some(filter=>matches(event,filter)))return;
          const coordinate=`${event.kind}:${event.pubkey}`;if(!newer(event,winners.get(coordinate)))return;
          winners.set(coordinate,event);if(event.kind===0)cacheProfileMetadata(event,{relays,now:now()});
        }catch{/* Invalid records cannot replace a verified profile. */}
      },
      onEose(status){completed=status.sources.filter(source=>source.complete).length;if(!grace)grace=setTimeout(()=>finish(!completed&&!winners.size?new Error('Could not load public profile records'):undefined),PROFILE_LIMITS.settleGraceMs);},
      // A failed source must not discard another source's late valid record.
    });if(finished)subscription.close(); } catch(error){finish(error);}
  });
}

function fallback(pubkey: string): PublicProfile {
  return { pubkey, name: profileLabel(pubkey), about: '', pictureUrl: null, website: null, nip05: '', metadataFound: false }
}
function storeFor(relays: readonly string[]): ProfileStore {
  const key = relayKey(relays)
  if (!caches.has(key)) {
    if (caches.size >= 3) caches.delete(caches.keys().next().value)
    caches.set(key, { profiles: new Map(), follows: new Map(), contexts: new Map() })
  }
  return caches.get(key)
}
function ingest(store, events, now) {
  for (const event of events) {
    const map = event.kind === 0 ? store.profiles : store.follows
    if (!newer(event, map.get(event.pubkey)?.event)) continue
    try {
      const value = event.kind === 0 ? { event, profile: parseProfileEvent(event, { now }) } : parseFollowEvent(event, { now })
      if (!map.has(event.pubkey) && map.size >= 512) map.delete(map.keys().next().value)
      map.set(event.pubkey, value)
    } catch {
      // A newer signed but unsupported revision must not resurrect an older
      // profile or follow list from this session's cache.
      if (!map.has(event.pubkey) && map.size >= 512) map.delete(map.keys().next().value)
      map.set(event.pubkey, event.kind === 0 ? { event, profile: null } : { event, follows: null })
    }
    if (event.kind === 3) store.contexts.clear()
    else {
      rememberProfile(event);
      for(const [key,cached] of caches)if(cached===store)for(const listener of metadataObservers.get(key)??[]) { try{listener(person(store,event.pubkey));}catch{/* A view cannot break cache admission. */} }
    }
  }
}
function person(store: ProfileStore, pubkey: string): PublicProfile {
  const head=profileHeads()?.read(pubkey);
  if(head&&newer(head,store.profiles.get(pubkey)?.event)){
    let profile:PublicProfile|null=null;try{profile=parseProfileEvent(head);}catch{}
    if(!store.profiles.has(pubkey)&&store.profiles.size>=512)store.profiles.delete(store.profiles.keys().next().value);
    store.profiles.set(pubkey,{event:head,profile});
  }
  return store.profiles.get(pubkey)?.profile || fallback(pubkey);
}

/** Port of Iris Chat's badge projection; every label states graph evidence, never identity verification. */
export function socialConnection(graph: SocialGraph | null, contextPubkey: string, target: string): SocialConnection {
  const root = normalizePublicKey(contextPubkey), key = normalizePublicKey(target)
  if (!graph || graph.getRoot() !== root) return { distance: null, badge: null, knownFollowers: [], knownFollowerCount: 0, description: 'Social connection unavailable', partial: true }
  const rawDistance = graph.getFollowDistance(key)
  const distance = rawDistance < 1000 ? rawDistance : null
  const knownFollowers = [...graph.followedByFriends(key)].sort()
  const label = root === DEFAULT_SOCIAL_GRAPH_ROOT ? DEFAULT_SOCIAL_GRAPH_LABEL : 'the selected profile'
  const badge = distance === 0 || distance === 1 ? 'following' : distance === 2 ? knownFollowers.length > 10 ? 'trusted' : 'friend' : null
  const description = distance === 0 ? `Network root · ${label}` : distance === 1 ? `Followed by ${label}` : knownFollowers.length ? `Followed by ${knownFollowers.length} known ${knownFollowers.length === 1 ? 'person' : 'people'}` : 'No connection found in loaded lists'
  return { distance, badge, knownFollowers, knownFollowerCount: knownFollowers.length, description, partial: true }
}

async function buildGraph(root: string, lists: Map<string, FollowRecord>) {
  const graph = new SocialGraph(root)
  // Winner selection is ours: the upstream graph's timestamp-only replacement
  // must not make equal-time results depend on relay arrival order.
  graph.handleEvent([...lists.values()].map(value => value.event), true, Infinity)
  await graph.recalculateFollowDistances(1000, 100000, () => {})
  return graph
}

// The binary is discovery/ranking evidence only. Signed observed lists replace
// its projections even when the snapshot carries a newer unverified timestamp.
async function overlayVerifiedLists(graph: SocialGraph, lists: Map<string, FollowRecord>) {
  const internal = graph.getInternalData()
  for (const [author, record] of lists) {
    internal.followListCreatedAt.delete(internal.ids.id(author))
    if (record.follows) graph.handleEvent(record.event, true, Infinity)
    else for (const followed of graph.getFollowedByUser(author)) graph.removeFollower(author, followed)
  }
  await graph.recalculateFollowDistances(1000, 100000, () => {})
}

function relevantFollowLists(direct, targetAuthors, graph) {
  if (!graph || !targetAuthors.length) return direct.slice(0, PROFILE_LIMITS.secondHop)
  const scores = new Map()
  for (const author of targetAuthors) for (const follower of graph.getFollowersByUser(author)) scores.set(follower, (scores.get(follower) || 0) + 1)
  return [...direct].sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0) || a.localeCompare(b)).slice(0, PROFILE_LIMITS.secondHop)
}

export async function loadCurationContext({ relays = DEFAULT_RELAYS, contextPubkey = DEFAULT_SOCIAL_GRAPH_ROOT, signal, WebSocketImpl, runtime, now = seconds, timeoutMs, targetAuthors = [], bootstrapLoader = loadGraphBootstrap }: CurationOptions = {}): Promise<CurationContext> {
  const root = normalizePublicKey(contextPubkey), store = storeFor(relays)
  const targets = [...new Set((Array.isArray(targetAuthors) ? targetAuthors : []).filter(isKey))].sort().slice(0, 128)
  const cacheKey = JSON.stringify([root, targets]), cached = store.contexts.get(cacheKey)
  if (signal?.aborted) throw abortError()
  if (cached && now() - cached.loadedAt < 120) return cached.result
  const options = { relays, signal, WebSocketImpl, runtime, now, timeoutMs }
  const warnings: string[] = [], selected = new Map<string, FollowRecord>()
  const bootstrapTask = root === DEFAULT_SOCIAL_GRAPH_ROOT ? bootstrapLoader({ root, signal }).catch(error => ({ error })) : Promise.resolve(null)
  let completed = 0
  try {
    const response = await queryProfileRecords([{ kinds: [0, 3], authors: [root], limit: 2 }], options)
    ingest(store, response.events, now()); completed += response.completed
    if (response.limited) warnings.push('The network lookup reached its size limit.')
  } catch (error) { if (error.name === 'AbortError') throw error; warnings.push(error.message) }
  const loadedBootstrap = await bootstrapTask
  if (signal?.aborted) throw abortError()
  const bootstrap = loadedBootstrap?.graph?.getRoot() === root ? loadedBootstrap : null
  if (loadedBootstrap?.error) warnings.push('Saved network unavailable; using signed live lists.')
  const rootRecord = store.follows.get(root)
  const rootList = rootRecord?.follows ? rootRecord : null
  if (rootRecord && !rootList) warnings.push('The root follow list is unavailable within the supported limits.')
  if (rootList) selected.set(root, rootList)
  // A newer unsupported signed root list must not revive old snapshot edges.
  const rankingGraph = rootRecord && !rootList ? null : bootstrap?.graph ?? null
  if (rankingGraph) await overlayVerifiedLists(rankingGraph, store.follows)
  const direct = rootList?.follows ?? (rankingGraph ? [...rankingGraph.getFollowedByUser(root)].sort() : [])
  const secondHop = relevantFollowLists(direct, targets, rankingGraph)
  if (secondHop.length) {
    try {
      const response = await queryProfileRecords([{ kinds: [3], authors: secondHop, limit: secondHop.length }], options)
      ingest(store, response.events, now()); completed += response.completed
      if (response.limited) warnings.push('Some network lists could not be loaded within the limit.')
    } catch (error) { if (error.name === 'AbortError') throw error; warnings.push(error.message) }
    for (const key of secondHop) if (store.follows.get(key)?.follows) selected.set(key, store.follows.get(key))
  }
  if (signal?.aborted) throw abortError()
  const graph = rootList ? await buildGraph(root, selected) : null
  if (rankingGraph) await overlayVerifiedLists(rankingGraph, store.follows)
  const coverage = Object.freeze({ partial: true, rootLoaded: !!rootList, directFollows: rootList?.follows.length ?? null, secondHopRequested: secondHop.length, secondHopLoaded: selected.size - Number(selected.has(root)), completedRelays: completed, bootstrap: rankingGraph ? bootstrap.provenance : null, warnings })
  const relationFor = pubkey => socialConnection(graph, root, pubkey)
  const result = { contextPubkey: root, contextLabel: root === DEFAULT_SOCIAL_GRAPH_ROOT ? DEFAULT_SOCIAL_GRAPH_LABEL : person(store, root).name,
    relationFor,
    rankRelationFor: pubkey => {
      const verified = relationFor(pubkey)
      if (verified.distance !== null || !rankingGraph) return { distance: verified.distance, knownFollowerCount: verified.knownFollowerCount, source: 'signed-observation', partial: true }
      const discovery = socialConnection(rankingGraph, root, pubkey)
      return { distance: discovery.distance, knownFollowerCount: discovery.knownFollowerCount, source: 'bundled-snapshot', stale: true, partial: true }
    },
    coverage, graph, lists: selected }
  if (store.contexts.size >= 4) store.contexts.delete(store.contexts.keys().next().value)
  store.contexts.set(cacheKey, { result, loadedAt: now() })
  return result
}

export async function loadProfile(pubkey: string, options: CurationOptions = {}) {
  const target = normalizePublicKey(pubkey), relays = options.relays || DEFAULT_RELAYS
  const now = options.now || seconds, signal = options.signal, store = storeFor(relays)
  const requestOptions = { ...options, relays, now, targetAuthors: [...(options.targetAuthors || []), target] }
  const warnings = []
  const safeQuery = async filters => {
    try {
      const result = await queryProfileRecords(filters, requestOptions)
      ingest(store, result.events, now())
      if (result.limited) warnings.push('Some profile records exceeded the lookup limit.')
      return result.events
    } catch (error) { if (error.name === 'AbortError') throw error; warnings.push(error.message); return [] }
  }
  const [context] = await Promise.all([
    loadCurationContext(requestOptions),
    safeQuery([{ kinds: [0, 3], authors: [target], limit: 2 }]),
  ])
  const followingRecord = store.follows.get(target)
  const following = followingRecord?.follows ? followingRecord : null
  if (followingRecord && !following) warnings.push('This follow list exceeds the supported size.')
  const known = context.relationFor(target).knownFollowers
  const peopleKeys = [...new Set([target, context.contextPubkey, ...known, ...(following?.follows || [])])].slice(0, PROFILE_LIMITS.metadata)
  if (peopleKeys.length) await safeQuery([{ kinds: [0], authors: peopleKeys, limit: peopleKeys.length }])
  if (signal?.aborted) throw abortError()
  const rootList = context.lists.get(context.contextPubkey)
  const contextFollowsTarget = rootList ? rootList.follows.includes(target) : null
  const targetFollowsContext = following ? following.follows.includes(context.contextPubkey) : null
  return { profile: person(store, target), contextPubkey: context.contextPubkey, contextLabel: context.contextLabel,
    relation: context.relationFor(target), mutualFollowing: contextFollowsTarget === null || targetFollowsContext === null ? null : contextFollowsTarget && targetFollowsContext,
    followsContext: targetFollowsContext, following: { items: (following?.follows || []).slice(0, PROFILE_LIMITS.display).map(key => person(store, key)), total: following?.follows.length ?? null, truncated: (following?.follows.length || 0) > PROFILE_LIMITS.display },
    followers: { items: [] as PublicProfile[], observedCount: 0, complete: false as const, loaded: false },
    followedByKnown: known.map(key => person(store, key)), coverage: { ...context.coverage, inboundCandidates: 0, inboundRefreshed: 0, warnings: [...context.coverage.warnings, ...warnings] } }
}

/** Explicit Followers action only. Known connections never perform an inbound scan. */
export async function loadProfileFollowers(pubkey:string, options:CurationOptions={}) {
  const target=normalizePublicKey(pubkey),relays=options.relays||DEFAULT_RELAYS,now=options.now||seconds,store=storeFor(relays);
  const query=async(filters:ProfileFilter[])=>{const result=await queryProfileRecords(filters,{...options,relays,now});ingest(store,result.events,now());return result.events;};
  const inbound=await query([{kinds:[3],'#p':[target],limit:PROFILE_LIMITS.inbound}]);
  const candidates=[...new Set(inbound.filter(event=>event.pubkey!==target&&event.tags.some(tag=>tag[0]==='p'&&tag[1]===target)).map(event=>event.pubkey))].sort().slice(0,PROFILE_LIMITS.inbound);
  // Refresh without #p: an older follow must not survive a later unfollow.
  const refreshed=candidates.length?await query([{kinds:[3],authors:candidates,limit:candidates.length}]):[];
  const authors=new Set(refreshed.map(event=>event.pubkey));
  const followers=candidates.filter(key=>authors.has(key)&&store.follows.get(key)?.follows?.includes(target));
  const warnings:string[]=[];
  if(followers.length)try{await query([{kinds:[0],authors:followers,limit:followers.length}]);}catch(error){if(error.name==='AbortError')throw error;warnings.push('Some names are unavailable.');}
  if(options.signal?.aborted)throw abortError();
  return {items:followers.map(key=>person(store,key)),observedCount:followers.length,complete:false as const,loaded:true as const,warnings};
}

/** Clear only this module's public in-memory cache, useful on explicit identity/relay changes. */
export function clearProfileCache() { caches.clear();clearTimeout(headFlush);headFlush=undefined;startupHeads?.flush();startupHeads=undefined; }

/** Shared, bounded profile hydration; no social-graph expansion for a name/avatar. */
export function cacheProfileMetadata(input: NostrEvent, { relays = DEFAULT_RELAYS, now = seconds() }: {relays?: readonly string[]; now?: number} = {}) {
  const event = verifyProfileRecord(input, { now });
  if (event.kind !== 0) throw new Error('Expected profile metadata');
  const store = storeFor(relays);
  ingest(store, [event], now);
  return person(store, event.pubkey);
}
export function readProfileMetadata(pubkey: string, { relays = DEFAULT_RELAYS }: {relays?: readonly string[]} = {}) {
  return person(storeFor(relays), normalizePublicKey(pubkey))
}
export async function loadProfileMetadata(pubkeys: string[], options: ProfileQueryOptions = {}) {
  const keys = [...new Set(pubkeys.map(normalizePublicKey))].slice(0, PROFILE_LIMITS.metadata)
  const relays = options.relays || DEFAULT_RELAYS, store = storeFor(relays), now = options.now || seconds
  if (keys.length) {
    const response = await queryProfileRecords([{ kinds: [0], authors: keys, limit: keys.length * 2 }], { ...options, relays, now })
    ingest(store, response.events, now())
  }
  return keys.map(key => person(store, key))
}

/** Keep receiving verified metadata when shared cache writes outlast historical EOSE. */
export function watchProfileMetadata(pubkeys: string[], { relays = DEFAULT_RELAYS, runtime = getPublicRuntime(relays), signal, now = seconds,
  lifetimeMs = 90000, onChange = () => {}, onClose = () => {} }: {
  relays?: readonly string[]; runtime?: PublicEventRuntime; signal?: AbortSignal; now?: () => number; lifetimeMs?: number;
  onChange?: (profile: PublicProfile) => void; onClose?: () => void;
} = {}) {
  const keys = new Set(pubkeys.map(normalizePublicKey).slice(0, PROFILE_LIMITS.metadata)), store = storeFor(relays)
  if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 90000) throw new Error('Invalid metadata subscription lifetime')
  let stopped = false, frames = 0, bytes = 0, subscription: ReturnType<PublicEventRuntime['subscribe']> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const close = () => { if (stopped) return; stopped = true; clearTimeout(timer); signal?.removeEventListener('abort', close); subscription?.close(); onClose() }
  if (signal?.aborted || !keys.size) { close(); return { close } }
  signal?.addEventListener('abort', close, { once: true }); timer = setTimeout(close, lifetimeMs)
  subscription = runtime.subscribe([{ kinds: [0], authors: [...keys], limit: keys.size * 2 }], {
    onEvent(raw) {
      if (stopped) return
      if (++frames > PROFILE_LIMITS.queryEvents) { close(); return }
      bytes += encoder.encode(JSON.stringify(raw)).length
      if (bytes > PROFILE_LIMITS.queryBytes) { close(); return }
      try {
        const event = verifyProfileRecord(raw, { now: now() })
        if (event.kind !== 0 || !keys.has(event.pubkey) || !newer(event, store.profiles.get(event.pubkey)?.event)) return
        ingest(store, [event], now()); onChange(person(store, event.pubkey))
      } catch { /* Untrusted metadata never replaces the signed winner. */ }
    },
    // Historical completion is not the end of a live subscription. In
    // particular, delayed admission must still reach rows already on screen.
  })
  if (stopped) subscription.close()
  return { close }
}
