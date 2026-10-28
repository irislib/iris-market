import test, { beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { npubEncode, nsecEncode } from 'nostr-tools/nip19'
import { fetchFollows, normalizePublicKey } from '../src/social.js'

const now = 1800000000
// The graph library also checks the real clock when accepting signed lists.
beforeEach(() => mock.method(Date, 'now', () => now * 1000))
afterEach(() => mock.restoreAll())
const secret = new Uint8Array(32).fill(1)
const otherSecret = new Uint8Array(32).fill(2)
const pubkey = getPublicKey(secret)
const alice = getPublicKey(otherSecret)
const bob = getPublicKey(new Uint8Array(32).fill(3))
const signed = ({ tags = [['p', alice]], createdAt = now - 10, kind = 3, key = secret, content = '' } = {}) =>
  finalizeEvent({ kind, created_at: createdAt, tags, content }, key)

class FakeSocket {
  static sockets = []
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closeCount = 0; FakeSocket.sockets.push(this) }
  send(value) { this.sent.push(JSON.parse(value)) }
  open() { this.readyState = 1; this.onopen?.() }
  frame(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
  event(event) { this.frame(['EVENT', this.sent[0][1], event]) }
  eose() { this.frame(['EOSE', this.sent[0][1]]) }
  close() { this.readyState = 3; this.closeCount++; this.onclose?.() }
}
const start = options => {
  FakeSocket.sockets = []
  const result = fetchFollows(pubkey, { relays: ['wss://one.example'], WebSocketImpl: FakeSocket, now: () => now, ...options })
  return { result, sockets: FakeSocket.sockets }
}
const closed = sockets => assert(sockets.every(socket => socket.readyState === 3 && socket.onmessage === null && socket.onopen === null))

test('public input accepts npub or hex without accepting private keys or profile hints', () => {
  assert.equal(normalizePublicKey(` ${pubkey.toUpperCase()} `), pubkey)
  assert.equal(normalizePublicKey(npubEncode(pubkey)), pubkey)
  for (const invalid of [null, '', 'x'.repeat(257), '0'.repeat(63), nsecEncode(secret), `nostr:${npubEncode(pubkey)}`, 'https://example.com/profile']) {
    assert.throws(() => normalizePublicKey(invalid), error => error.code === 'invalid-key' && (!invalid || !error.message.includes(String(invalid))))
  }
})

test('latest signed contact list replaces older lists, deduplicates keys, and sends only narrow read requests', async () => {
  const { result, sockets } = start({ relays: ['wss://one.example', 'wss://two.example'] })
  const [a, b] = sockets
  a.open(); b.open()
  a.event(signed({ createdAt: now - 20 }))
  b.event(signed({ tags: [['p', bob, 'wss://ignored-hint.example'], ['p', bob], ['p', 'bad'], ['t', alice]], content: 'Not sent elsewhere' }))
  a.eose(); b.eose()
  assert.deepEqual(await result, { pubkey, authors: [bob] })
  closed(sockets)
  for (const socket of sockets) {
    assert.deepEqual(socket.sent[0][2], { kinds: [3], authors: [pubkey], limit: 1 })
    assert(socket.sent.every(frame => frame[0] === 'REQ' || frame[0] === 'CLOSE'))
  }
})

test('equal timestamp revisions converge to the smallest event ID in either arrival order', async () => {
  const a = signed({ tags: [['p', alice]] }), b = signed({ tags: [['p', bob]] })
  const expected = a.id < b.id ? alice : bob
  for (const events of [[a, b], [b, a]]) {
    const { result, sockets: [socket] } = start()
    socket.open(); events.forEach(event => socket.event(event)); socket.eose()
    assert.deepEqual((await result).authors, [expected])
  }
})

test('forged, wrong-author, wrong-kind, future and wrong-subscription events cannot enter the result', async () => {
  const { result, sockets: [socket] } = start()
  socket.open()
  const forged = signed({ createdAt: now - 1 }); forged.tags = [['p', bob]]
  socket.event(forged)
  socket.event(signed({ key: otherSecret }))
  socket.event(signed({ kind: 1 }))
  socket.event(signed({ createdAt: now + 301 }))
  socket.frame(['EVENT', 'unrelated', signed()])
  socket.eose()
  await assert.rejects(result, { code: 'unavailable' })
  closed([socket])
})

test('a verified empty contact list is distinct from missing data and supersedes old follows', async () => {
  const { result, sockets: [socket] } = start()
  socket.open(); socket.event(signed()); socket.event(signed({ tags: [], createdAt: now - 1 })); socket.eose()
  assert.deepEqual(await result, { pubkey, authors: [] })
  const missing = start(); missing.sockets[0].open(); missing.sockets[0].eose()
  await assert.rejects(missing.result, { code: 'unavailable' })
})

test('abort closes all sockets and rejects even after receiving a signed event', async () => {
  const controller = new AbortController()
  const { result, sockets } = start({ signal: controller.signal, relays: ['wss://one.example', 'wss://two.example'] })
  sockets[0].open(); sockets[0].event(signed()); controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  closed(sockets)
  const early = start({ signal: controller.signal })
  await assert.rejects(early.result, { name: 'AbortError' }); assert.equal(early.sockets.length, 0)
})

test('deadline closes stalled relays, rejecting when no relay completed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { result, sockets } = start({ timeoutMs: 20 })
  sockets[0].open(); sockets[0].event(signed())
  t.mock.timers.tick(20)
  await assert.rejects(result, { code: 'timeout' })
  closed(sockets)
})

test('an available verified list survives an unavailable relay without waiting past the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { result, sockets } = start({ relays: ['wss://one.example', 'wss://two.example'], timeoutMs: 20 })
  sockets[0].open(); sockets[0].event(signed()); sockets[0].eose()
  t.mock.timers.tick(20)
  assert.deepEqual((await result).authors, [alice]); closed(sockets)
})

test('oversized and excessive relay responses fail explicitly instead of truncating the graph', async () => {
  for (const send of [
    socket => socket.onmessage({ data: 'x'.repeat(1024 * 1024 + 2049) }),
    socket => { for (let i = 0; i < 33; i++) socket.frame(['NOTICE', 'ignored']) },
    socket => { for (let i = 0; i < 9; i++) socket.event(signed()) },
    socket => socket.event(signed({ tags: Array.from({ length: 10001 }, () => ['p', alice]) })),
    socket => socket.event(signed({ tags: Array.from({ length: 257 }, (_, i) => ['p', i.toString(16).padStart(64, '0')]) })),
  ]) {
    const { result, sockets: [socket] } = start()
    socket.open(); send(socket)
    await assert.rejects(result, { code: 'limit' }); closed([socket])
  }
})

test('transport errors, constructor failures and invalid configuration never become an empty follow list', async () => {
  const failure = start(); failure.sockets[0].onerror()
  await assert.rejects(failure.result, { code: 'unavailable' }); closed(failure.sockets)
  const broken = start({ WebSocketImpl: class { constructor() { throw new Error('offline') } } })
  await assert.rejects(broken.result, { code: 'unavailable' })
  for (const options of [{ relays: [] }, { relays: ['ws://remote.example'] }, { relays: Array(9).fill('wss://one.example') }, { timeoutMs: 0 }, { timeoutMs: 30001 }, { WebSocketImpl: null }]) {
    const invalid = start(options); await assert.rejects(invalid.result); assert.equal(invalid.sockets.length, 0)
  }
})


test('direct follows use library graph semantics and exclude self edges', async () => {
  const { result, sockets: [socket] } = start()
  socket.open(); socket.event(signed({ tags: [['p', pubkey], ['p', alice], ['p', alice]] })); socket.eose()
  assert.deepEqual((await result).authors, [alice])
  closed([socket])
})
