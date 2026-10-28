import test from 'node:test'
import assert from 'node:assert/strict'
import { sha256, toHex } from '@hashtree/core'
import { decodeGeohash, locationFromTags } from '../src/map/geohash.js'
import { MAP_ROOT, GLYPH_ROOT, cacheBytes, validatePath } from '../src/map/config.js'
import { MapBlockCache, readBounded } from '../src/map/cache.js'
import { createPmtilesSource } from '../src/map/source.js'
import { createListingOverlay } from '../src/map/index.js'

class MemoryStore {
  values = new Map(); evictions = []; closed = false
  async get(hash) { return this.values.get(toHex(hash)) ?? null }
  async has(hash) { return this.values.has(toHex(hash)) }
  async put(hash, data) { this.values.set(toHex(hash), data); return true }
  async delete(hash) { return this.values.delete(toHex(hash)) }
  async totalBytes() { return [...this.values.values()].reduce((sum, value) => sum + value.byteLength, 0) }
  async evict(limit) { this.evictions.push(limit); while (await this.totalBytes() > limit) this.values.delete(this.values.keys().next().value) }
  async count() { return this.values.size }
  async clear() { this.values.clear() }
  close() { this.closed = true }
}

test('geohash pins are cell centres, invalid strings ignored, most specific tag chosen', () => {
  const cell = decodeGeohash('UD9WR')
  assert.equal(cell.geohash, 'ud9wr')
  assert(cell.coordinates[0] > 24 && cell.coordinates[0] < 26)
  assert(cell.coordinates[1] > 60 && cell.coordinates[1] < 61)
  assert(Object.isFrozen(cell.coordinates))
  assert.deepEqual(locationFromTags([['location', 'Tokyo'], ['g', 'ud'], ['g', 'ud9wr']]), cell)
  for (const input of ['', 'Helsinki', '../u6', 'u60sc!', 'u'.repeat(13), null]) assert.equal(decodeGeohash(input), null)
  assert.equal(locationFromTags([['location', 'Helsinki'], ['g', 'invalid!']]), null)
})

test('only known immutable roots and relative map asset paths are permitted', () => {
  assert.equal(validatePath(MAP_ROOT, 'ofm/positron.json'), 'ofm/positron.json')
  assert.equal(validatePath(GLYPH_ROOT, 'ofm/Noto Sans Regular/0-255.pbf'), 'ofm/Noto Sans Regular/0-255.pbf')
  for (const path of ['../x', '/x', 'a//b', 'a/./b']) assert.throws(() => validatePath(MAP_ROOT, path))
  assert.throws(() => validatePath('https://unknown.example', 'x'))
  assert.equal(cacheBytes(128), 134217728)
  for (const size of [0, -1, 1024, 128.5, '128']) assert.throws(() => cacheBytes(size))
})

test('map responses are bounded even when content-length is missing or misleading', async () => {
  assert.deepEqual(await readBounded(new Response(new Uint8Array([1, 2, 3])), 3), new Uint8Array([1, 2, 3]))
  await assert.rejects(readBounded(new Response(new Uint8Array(4)), 3), /too large/)
  await assert.rejects(readBounded(new Response(new Uint8Array(1), { headers: { 'content-length': '9' } }), 3), /too large/)
  await assert.rejects(readBounded(new Response('', { status: 503 })), /503/)
})

test('verified blocks persist, duplicate reads coalesce, and cached blocks work offline', async () => {
  const data = new TextEncoder().encode('a map block'), hash = await sha256(data), store = new MemoryStore()
  let reads = 0
  const cache = new MapBlockCache({ store, locks: null, fetchImpl: async (url, init) => {
    reads++; assert.equal(url, `https://cdn.iris.to/${toHex(hash)}.bin`)
    assert.equal(init.credentials, 'omit'); return new Response(data)
  } })
  const values = await Promise.all([cache.get(hash), cache.get(hash)])
  assert.deepEqual(values, [data, data]); assert.equal(reads, 1)
  cache.fetch = async () => { throw new Error('Offline') }
  assert.deepEqual(await cache.get(hash), data)
  assert.equal((await cache.getStorageStats()).bytes, data.byteLength)
  assert(store.evictions.includes(cacheBytes(128) - data.byteLength))
  assert.equal((await cache.setCacheMiB(64)).maxBytes, cacheBytes(64))
  assert.equal((await cache.clearCache()).bytes, 0)
  await cache.close(); assert(store.closed)
  await assert.rejects(cache.get(hash), /cancelled/)
})

test('a wrong block hash is rejected before it reaches storage', async () => {
  const store = new MemoryStore(), hash = await sha256(new Uint8Array([1]))
  const cache = new MapBlockCache({ store, locks: null, fetchImpl: async () => new Response(new Uint8Array([2])) })
  await assert.rejects(cache.get(hash), /integrity/)
  assert.equal(await store.count(), 0)
  await cache.close()
})

test('clear aborts an outstanding download without repopulating the cache', async () => {
  const store = new MemoryStore(), data = new Uint8Array([1]), hash = await sha256(data)
  let began
  const started = new Promise(resolve => { began = resolve })
  const cache = new MapBlockCache({ store, locks: null, fetchImpl: async (_, { signal }) => {
    began(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
  } })
  const pending = cache.get(hash)
  await started
  const cleared = cache.clearCache()
  await assert.rejects(pending, /Aborted/)
  assert.equal((await cleared).bytes, 0)
  await cache.close()
})

test('PMTiles source passes only bounded requested ranges to the immutable archive', async () => {
  const calls = [], controller = new AbortController()
  const source = createPmtilesSource({ read: async (...args) => { calls.push(args); return new Uint8Array([4, 5]) } }, 'marketmap1://archive')
  const result = await source.getBytes(1234, 2, controller.signal)
  assert.equal(source.getKey(), 'marketmap1://archive')
  assert.deepEqual(calls, [[MAP_ROOT, 'tiles.pmtiles', { start: 1234, length: 2, signal: controller.signal }]])
  assert.deepEqual(new Uint8Array(result.data), new Uint8Array([4, 5]))
  assert.equal(result.etag, MAP_ROOT)
})

test('a failed eviction never permits a new block to exceed the cache budget', async () => {
  const store = new MemoryStore(), data = new Uint8Array([7]), hash = await sha256(data)
  const cache = new MapBlockCache({ cacheMiB: 64, store, locks: null, fetchImpl: async () => new Response(data) })
  await cache.ready
  store.totalBytes = async () => cacheBytes(64)
  store.evict = async () => 0
  await assert.rejects(cache.get(hash), /limit could not be enforced/)
  assert.equal(await store.count(), 0)
  await cache.close()
})

test('new reads are rejected while a requested cache clear is still pending', async () => {
  const store = new MemoryStore(), hash = await sha256(new Uint8Array([1]))
  let finishClear
  const cleared = new Promise(resolve => { finishClear = resolve })
  store.clear = () => cleared
  const cache = new MapBlockCache({ store, locks: null, fetchImpl: async () => { throw new Error('Must not fetch') } })
  await cache.ready
  const pending = cache.clearCache()
  await assert.rejects(cache.get(hash), /cancelled/)
  finishClear()
  await pending
  assert.equal((await cache.getStorageStats()).bytes, 0)
  await cache.close()
})


test('native fetch keeps the browser global receiver when stored on the cache', async () => {
  const data = new Uint8Array([9]), hash = await sha256(data), store = new MemoryStore()
  const cache = new MapBlockCache({ store, locks: null, fetchImpl: function () {
    assert.equal(this, globalThis)
    return Promise.resolve(new Response(data))
  } })
  assert.deepEqual(await cache.get(hash), data)
  await cache.close()
})


function overlayMap() {
  const handlers = new Map(), sources = new Map(), layers = new Map()
  let updates = 0
  return {
    on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn) },
    off(event, fn) { handlers.get(event)?.delete(fn) },
    emit(event) { for (const fn of handlers.get(event) ?? []) fn() },
    // A loading basemap must not prevent the marketplace overlay from updating.
    isStyleLoaded() { return false },
    getSource(id) { return sources.get(id) },
    addSource(id, value) { assert(!sources.has(id)); sources.set(id, { ...value, setData(data) { this.data = data; updates++ } }) },
    getLayer(id) { return layers.get(id) },
    addLayer(value) { assert(!layers.has(value.id)); layers.set(value.id, value) },
    setPaintProperty(id, name, value) { layers.get(id).paint[name] = value },
    resetStyle() { sources.clear(); layers.clear() },
    get updates() { return updates },
  }
}
const helsinkiPin = { id: 'helsinki', title: 'Bike', coordinates: [24.94, 60.17] }
const parisPin = { id: 'paris', title: 'Delivery', coordinates: [2.35, 48.85] }

test('listing pins appear and update while basemap tiles are still loading', () => {
  const map = overlayMap(), overlay = createListingOverlay(map)
  overlay.setListings([helsinkiPin])
  assert.equal(map.getSource('market-listings'), undefined)
  map.emit('style.load')
  assert.equal(map.getSource('market-listings').data.features[0].id, 'helsinki')
  for (const id of ['market-pins', 'market-clusters', 'market-cluster-count']) assert(map.getLayer(id))
  overlay.setListings([parisPin])
  assert.equal(map.getSource('market-listings').data.features[0].id, 'paris')
  const updates = map.updates
  map.emit('sourcedata')
  assert.equal(map.updates, updates)
  overlay.setListings([])
  assert.deepEqual(map.getSource('market-listings').data.features, [])
  overlay.destroy()
})

test('theme replacement restores the latest listings and pin colors exactly once', () => {
  const map = overlayMap(), overlay = createListingOverlay(map, [helsinkiPin])
  map.emit('style.load')
  overlay.beginStyleChange(true)
  map.resetStyle()
  overlay.setListings([parisPin])
  assert.equal(map.getSource('market-listings'), undefined)
  map.emit('style.load')
  assert.equal(map.getSource('market-listings').data.features[0].id, 'paris')
  assert.equal(map.getLayer('market-pins').paint['circle-stroke-color'], '#f7f4eb')
  map.emit('load')
  assert.equal(map.getSource('market-listings').data.features.length, 1)
  overlay.beginStyleChange(false)
  map.emit('style.load')
  assert.equal(map.getLayer('market-pins').paint['circle-stroke-color'], '#172d2a')
  overlay.destroy()
  const updates = map.updates
  overlay.setListings([helsinkiPin])
  map.emit('style.load')
  assert.equal(map.updates, updates)
})
