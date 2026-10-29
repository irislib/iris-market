import { HashTree, nhashDecode, toHex, sha256, type Hash, type CID } from '@hashtree/core'
import { DexieStore } from '@hashtree/dexie'
import { BLOB_SERVER, DATABASE_NAME, DEFAULT_CACHE_MIB, cacheBytes, validatePath } from './config.ts'

export interface MapCacheStats { items: number; bytes: number; maxBytes: number }
export type MapCacheStore = Pick<DexieStore, 'get' | 'has' | 'put' | 'delete' | 'evict' | 'totalBytes' | 'count' | 'clear' | 'close'>
export interface MapCacheOptions { cacheMiB?: number; store?: MapCacheStore; fetchImpl?: typeof fetch; locks?: Pick<LockManager, 'request'> | null }
export interface MapReadOptions { start?: number; length?: number; signal?: AbortSignal }

const MAX_BLOCK_BYTES = 4 * 1024 * 1024
const MAX_READ_BYTES = 8 * 1024 * 1024
const abortError = () => new DOMException('Map request cancelled', 'AbortError')

export async function readBounded(response: Response, maxBytes = MAX_BLOCK_BYTES) {
  if (!response.ok) throw new Error(`Map data unavailable (${response.status})`)
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Map block is too large') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty map response')
  const chunks = []; let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error('Map block is too large')
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

/** Read-only Hashtree block store; cache shares no identities, drafts or messages. */
export class MapBlockCache {
  maxBytes: number
  store: MapCacheStore
  fetch: typeof fetch
  locks: MapCacheOptions['locks']
  closed: boolean
  clearing: boolean
  clearPromise: Promise<MapCacheStats> | null
  generation: number
  controller: AbortController
  inflight: Map<string, Promise<Uint8Array>>
  paths: Map<string, CID>
  serial: Promise<unknown>
  active: number
  queue: Array<{ resolve: () => void; reject: (reason?: unknown) => void }>
  tree: HashTree
  ready: Promise<void>
  constructor({ cacheMiB = DEFAULT_CACHE_MIB, store = new DexieStore(DATABASE_NAME), fetchImpl = globalThis.fetch, locks = globalThis.navigator?.locks }: MapCacheOptions = {}) {
    this.maxBytes = cacheBytes(cacheMiB); this.store = store; this.fetch = fetchImpl.bind(globalThis); this.locks = locks
    this.closed = false; this.clearing = false; this.clearPromise = null; this.generation = 0; this.controller = new AbortController()
    this.inflight = new Map(); this.paths = new Map(); this.serial = Promise.resolve(); this.active = 0; this.queue = []
    this.tree = new HashTree({ store: { get: hash => this.get(hash), has: hash => this.store.has(hash), put: async () => { throw new Error('Read-only map storage') }, delete: async () => false } })
    this.ready = this.mutate(() => this.enforceLimit(this.maxBytes))
  }
  async enforceLimit(limit: number) {
    await this.store.evict(limit)
    if (await this.store.totalBytes() > limit) throw new Error('Map cache limit could not be enforced')
  }
  mutate<T>(fn: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => this.locks ? await this.locks.request(DATABASE_NAME, fn) : await fn()
    const next = this.serial.catch(() => {}).then(execute)
    this.serial = next; return next
  }
  async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed || this.clearing) throw abortError()
    if (this.active >= 6) {
      if (this.queue.length >= 128) throw new Error('Too many map requests')
      await new Promise<void>((resolve, reject) => this.queue.push({ resolve, reject }))
    } else this.active++
    try { if (this.closed || this.clearing) throw abortError(); return await fn() }
    finally { const waiter = this.queue.shift(); if (waiter) waiter.resolve(); else this.active-- }
  }
  async get(hash: Hash): Promise<Uint8Array> {
    if (this.closed || this.clearing) throw abortError()
    const key = toHex(hash)
    if (this.inflight.has(key)) return this.inflight.get(key)
    if (this.inflight.size >= 160) throw new Error('Too many map blocks')
    const generation = this.generation
    const task = this.slot(async () => {
      await this.ready
      const local = await this.store.get(hash)
      if (local && local.byteLength <= MAX_BLOCK_BYTES && toHex(await sha256(local)) === key) return local
      if (local) await this.mutate(() => this.store.delete(hash))
      if (generation !== this.generation) throw abortError()
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(20000)])
      const response = await this.fetch(`${BLOB_SERVER}/${key}.bin`, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
      const data = await readBounded(response)
      if (toHex(await sha256(data)) !== key) throw new Error('Map block failed its integrity check')
      await this.mutate(async () => {
        if (this.closed || generation !== this.generation) throw abortError()
        // Reserve space before each insertion; the package's worker batches 32 writes.
        const available = Math.max(0, this.maxBytes - data.byteLength)
        await this.enforceLimit(available)
        if (!await this.store.put(hash, data)) throw new Error('Map cache could not be saved')
        await this.enforceLimit(this.maxBytes)
      })
      return data
    })
    this.inflight.set(key, task)
    try { return await task } finally { if (this.inflight.get(key) === task) this.inflight.delete(key) }
  }
  async resolve(root: string, path: string, signal?: AbortSignal): Promise<CID> {
    validatePath(root, path)
    if (this.closed || this.clearing || signal?.aborted) throw abortError()
    const key = `${root}/${path}`
    const existing = this.paths.get(key)
    if (existing) return existing
    const generation = this.generation
    const entry = await this.tree.resolvePath(nhashDecode(root), path, AbortSignal.any([this.controller.signal, AbortSignal.timeout(25000), ...(signal ? [signal] : [])]))
    if (generation !== this.generation || this.closed || this.clearing || signal?.aborted) throw abortError()
    if (!entry) throw new Error('Map asset is unavailable')
    if (this.paths.size >= 128) this.paths.delete(this.paths.keys().next().value)
    this.paths.set(key, entry.cid)
    return entry.cid
  }
  async read(root: string, path: string, { start, length, signal }: MapReadOptions = {}): Promise<Uint8Array> {
    if (start !== undefined && (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0 || length > MAX_READ_BYTES || !Number.isSafeInteger(start + length))) throw new Error('Invalid map range')
    const cid = await this.resolve(root, path, signal)
    if (signal?.aborted) throw abortError()
    const data = start === undefined ? await this.tree.readFile(cid, { maxBytes: MAX_READ_BYTES }) : await this.tree.readFileRange(cid, start, start + length)
    if (signal?.aborted || this.closed) throw abortError()
    if (!data) throw new Error('Map data is unavailable')
    if (data.byteLength > MAX_READ_BYTES) throw new Error('Map response is too large')
    return data
  }
  async getStorageStats(): Promise<MapCacheStats> {
    await this.ready; await this.serial
    return { items: await this.store.count(), bytes: await this.store.totalBytes(), maxBytes: this.maxBytes }
  }
  async setCacheMiB(value: number) { this.maxBytes = cacheBytes(value); await this.mutate(() => this.enforceLimit(this.maxBytes)); return this.getStorageStats() }
  async clearCache(): Promise<MapCacheStats> {
    if (this.clearPromise) return this.clearPromise
    if (this.closed) throw abortError()
    this.clearing = true
    this.clearPromise = this.clearStoredCache().finally(() => { this.clearing = false; this.clearPromise = null })
    return this.clearPromise
  }
  async clearStoredCache() {
    this.generation++; this.controller.abort(); this.controller = new AbortController(); this.paths.clear()
    for (const waiter of this.queue.splice(0)) waiter.reject(abortError())
    await Promise.allSettled([...this.inflight.values()])
    await this.mutate(() => this.store.clear())
    return this.getStorageStats()
  }
  async close() {
    if (this.closed) return
    this.closed = true; this.generation++; this.controller.abort(); this.paths.clear()
    for (const waiter of this.queue.splice(0)) waiter.reject(abortError())
    await Promise.allSettled([...this.inflight.values()]); await this.serial.catch(() => {}); this.store.close()
  }
}
