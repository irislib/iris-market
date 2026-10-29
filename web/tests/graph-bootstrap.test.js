import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { SocialGraph } from 'nostr-social-graph'
import { GRAPH_BOOTSTRAP, decodeGraphBootstrap, loadGraphBootstrap } from '../src/graph-bootstrap.ts'

const bytes = new Uint8Array(await readFile(new URL('../src/data/social-graph.bin', import.meta.url)))

test('the pinned company projection loads through the actual library with explicit stale provenance', async () => {
  let request
  const result = await loadGraphBootstrap({ fetchImpl: function (...args) { assert.equal(this, globalThis); request = args; return Promise.resolve(new Response(bytes)) } })
  assert(result.graph instanceof SocialGraph)
  assert.equal(result.graph.getRoot(), GRAPH_BOOTSTRAP.root)
  assert.equal(GRAPH_BOOTSTRAP.root, '336f319763657d6b0e65a5b5876719e8c8dcdcf9396852be71ee26b73368b29b')
  const sizes = result.graph.size().sizeByDistance
  assert.equal(sizes[0] + sizes[1] + sizes[2], 411)
  assert.equal(result.graph.getFollowedByUser(GRAPH_BOOTSTRAP.root).size, 2)
  assert.equal(result.graph.size().users, 31187)
  assert.equal(result.provenance.verifiedEvents, false)
  assert.equal(result.provenance.stale, true)
  assert(result.provenance.newestFollowAt > 0)
  assert.equal(request[0], GRAPH_BOOTSTRAP.url)
  assert.equal(request[1].credentials, 'omit')
  assert.equal(request[1].redirect, 'error')
  assert.equal(Object.isFrozen(result.provenance), true)
})

test('changed bytes, wrong identity and oversized responses never deserialize as a usable graph', async () => {
  const corrupted = bytes.slice(); corrupted[corrupted.length - 1] ^= 1
  await assert.rejects(decodeGraphBootstrap(corrupted), /integrity/)
  await assert.rejects(decodeGraphBootstrap(bytes.subarray(1)), /size/)
  await assert.rejects(loadGraphBootstrap({ root: '0'.repeat(64), fetchImpl: () => { throw Error('Must not fetch') } }), /different profile/)
  await assert.rejects(loadGraphBootstrap({ fetchImpl: async () => new Response('', { headers: { 'content-length': String(bytes.length + 1) } }) }), /too large/)
  await assert.rejects(loadGraphBootstrap({ fetchImpl: async () => new Response(new Uint8Array(bytes.length + 1)) }), /too large/)
  await assert.rejects(loadGraphBootstrap({ fetchImpl: async () => new Response('', { status: 503 }) }), /Could not load/)
})

test('separate loads never share a mutable graph and serialization uses the library budget API', async () => {
  const first = await decodeGraphBootstrap(bytes), second = await decodeGraphBootstrap(bytes)
  const followed = first.graph.getFollowedByUser(GRAPH_BOOTSTRAP.root).values().next().value
  first.graph.removeFollower(GRAPH_BOOTSTRAP.root, followed)
  assert.equal(second.graph.isFollowing(GRAPH_BOOTSTRAP.root, followed), true)
  const subset = await second.graph.toBinary(100, 150, 1, 100)
  const restored = await SocialGraph.fromBinary(GRAPH_BOOTSTRAP.root, subset)
  assert(restored.size().users <= 100); assert(restored.size().follows + restored.size().mutes <= 150)
})

test('aborted or timed out bootstrap requests cannot install a graph', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(loadGraphBootstrap({ signal: controller.signal, fetchImpl: () => { throw Error('Must not fetch') } }), { name: 'AbortError' })
  await assert.rejects(loadGraphBootstrap({ timeoutMs: 1, fetchImpl: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }), { name: 'TimeoutError' })
})
