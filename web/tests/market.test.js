import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { parseEvent, applyEvent, visibleListings, validateRelays, MarketRelayClient } from '../src/market.js'

const now = 1800000000
const secret = generateSecretKey()
const signed = ({ identifier = 'chair', createdAt = now - 20, status = 'active', extra = [], content = 'A comfortable chair', title = 'Oak lounge chair', tags, key = secret } = {}) => finalizeEvent({
  kind: 30402, created_at: createdAt, content,
  tags: tags ?? [['d', identifier], ['title', title], ['price', '85', 'EUR'], ['location', 'Helsinki'], ['t', 'Home'], ['market', 'offer'], ['status', status], ...extra],
}, key)

test('verified listings normalise offers, requests, images and categories', () => {
  const listing = parseEvent(signed({ extra: [['t', 'Furniture'], ['image', 'https://example.com/chair.jpg']] }), { now })
  assert.equal(listing.title, 'Oak lounge chair')
  assert.equal(listing.category, 'Home')
  assert.deepEqual(listing.tags, ['Home', 'Furniture'])
  assert(Object.isFrozen(listing.tags))
  assert.equal(listing.imageUrl, 'https://example.com/chair.jpg')
  assert.equal(listing.id, `${listing.author}:chair`)
  const request = signed({ tags: [['d', 'help'], ['title', 'Need a bicycle'], ['market', 'request']] })
  assert.equal(parseEvent(request, { now }).side, 'request')
  assert.equal(parseEvent(request, { now }).currency, 'EUR')
})

test('mutation cannot bypass signature verification through a cached verification Symbol', () => {
  const event = signed()
  event.content = 'A forged message'
  assert.throws(() => parseEvent(event, { now }), /signature/)
  const forged = JSON.parse(JSON.stringify(signed()))
  forged.sig = '0'.repeat(128)
  assert.throws(() => parseEvent(forged, { now }), /signature/)
})

test('sold and expired revisions remain tombstones across old relay replays', () => {
  const map = new Map()
  const original = signed()
  assert.equal(applyEvent(map, original, { now }), true)
  assert.equal(visibleListings(map, { now }).length, 1)
  assert.equal(applyEvent(map, signed({ status: 'sold', createdAt: now - 10 }), { now }), true)
  assert.equal(applyEvent(map, original, { now }), false)
  assert.equal(visibleListings(map, { now }).length, 0)
  assert.equal(map.size, 1)
  const expired = signed({ identifier: 'lamp', createdAt: now - 5, extra: [['expiration', String(now - 1)]] })
  applyEvent(map, expired, { now })
  applyEvent(map, signed({ identifier: 'lamp', createdAt: now - 6 }), { now })
  assert.equal(visibleListings(map, { now }).length, 0)
  assert.equal(map.size, 2)
})

test('equal timestamps converge to the smallest event ID independent of arrival order', () => {
  const a = signed({ content: 'Revision A' })
  const b = signed({ content: 'Revision B' })
  const first = new Map(), second = new Map()
  for (const e of [a, b]) applyEvent(first, e, { now })
  for (const e of [b, a]) applyEvent(second, e, { now })
  assert.equal([...first.values()][0].eventId, [a.id, b.id].sort()[0])
  assert.deepEqual([...first.values()], [...second.values()])
})

test('capacity retains tombstones and still allows newer revisions of known coordinates', () => {
  const map = new Map()
  applyEvent(map, signed({ status: 'sold' }), { now, maxRecords: 1 })
  assert.equal(applyEvent(map, signed({ identifier: 'different' }), { now, maxRecords: 1 }), false)
  assert.equal(applyEvent(map, signed({ createdAt: now - 1 }), { now, maxRecords: 1 }), true)
  assert.equal(visibleListings(map, { now }).length, 1)
})

test('unsafe or ambiguous fields and oversized events never enter the map', () => {
  const cases = [
    { extra: [['title', 'Duplicate']] },
    { extra: [['status', 'sold']] },
    { extra: [['image', 'javascript:alert(1)']] },
    { extra: [['image', 'http://example.com/a.jpg']] },
    { extra: [['image', 'https://user:password@example.com/a.jpg']] },
    { extra: [['expiration', '-1']] },
    { createdAt: now + 301 },
    { content: '€'.repeat(4001) },
    { title: 'x'.repeat(161) },
    { tags: [['d', 'chair'], ['title', 'Chair'], ['price', '0x10', 'EUR']] },
    { extra: [['irrelevant', 'x'.repeat(65536)]] },
  ]
  const map = new Map()
  for (const options of cases) assert.throws(() => applyEvent(map, signed(options), { now }))
  assert.equal(map.size, 0)
})

test('expiry takes effect without receiving another event', () => {
  const map = new Map()
  applyEvent(map, signed({ extra: [['expiration', String(now + 1)]] }), { now })
  assert.equal(visibleListings(map, { now }).length, 1)
  assert.equal(visibleListings(map, { now: now + 1 }).length, 0)
  assert.equal(map.size, 1)
})

test('relay URLs require secure transport outside local tests', () => {
  assert.deepEqual(validateRelays(['wss://nos.lol', 'wss://nos.lol/']), ['wss://nos.lol/'])
  assert.equal(validateRelays(['ws://127.0.0.1:1234']).length, 1)
  for (const value of ['https://nos.lol', 'ws://example.com', 'wss://user:pass@example.com', 'wss://example.com/#secret']) assert.throws(() => validateRelays([value]))
})

class FakeSocket {
  static sockets = []
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.sockets.push(this) }
  send(value) { this.sent.push(JSON.parse(value)) }
  open() { this.readyState = 1; this.onopen?.() }
  frame(value) { this.onmessage?.({ data: JSON.stringify(value) }) }
  close() { this.readyState = 3; this.onclose?.() }
}

test('relay client scopes events to subscriptions, stays read-only, and retains state after reconnect', async () => {
  FakeSocket.sockets = []
  const changes = [], statuses = []
  const client = new MarketRelayClient({ relays: ['wss://example.com'], WebSocketImpl: FakeSocket, now: () => now, onChange: rows => changes.push(rows), onStatus: state => statuses.push(state) }).start()
  try {
    const socket = FakeSocket.sockets[0]
    socket.open()
    const [verb, id, filter] = socket.sent[0]
    assert.equal(verb, 'REQ'); assert.deepEqual(filter, { kinds: [30402], limit: 300 })
    socket.frame(['EVENT', 'unrelated-subscription', signed()])
    assert.equal(client.listings().length, 0)
    const event = signed()
    socket.frame(['EVENT', id, event])
    socket.frame(['EVENT', id, event])
    socket.frame(['EOSE', id])
    assert.equal(client.listings().length, 1)
    assert.equal(statuses.at(-1).state, 'live')
    socket.frame(['EVENT', id, signed({ status: 'sold', createdAt: now - 2 })])
    assert.equal(client.listings().length, 0)
    client.refresh()
    socket.frame(['EVENT', id, event])
    assert.equal(client.listings().length, 0)
    assert.equal(client.records.size, 1)
    await new Promise(resolve => setTimeout(resolve, 35))
    assert.equal(changes.at(-1).length, 0)
  } finally { client.close() }
  assert.equal(statuses.at(-1).state, 'closed')
  assert(FakeSocket.sockets.flatMap(s => s.sent).every(frame => frame[0] === 'REQ' || frame[0] === 'CLOSE'))
})


test('shared listing links add a narrow lookup and reserve capacity for its verified result', () => {
  FakeSocket.sockets = []
  const target = signed({ identifier: 'old:shared-listing', createdAt: now - 10000 })
  const targetId = `${target.pubkey}:old:shared-listing`
  const client = new MarketRelayClient({ relays: ['wss://example.com'], targetId, maxRecords: 2, WebSocketImpl: FakeSocket, now: () => now }).start()
  try {
    const socket = FakeSocket.sockets[0]
    socket.open()
    const [, id, recent, exact] = socket.sent[0]
    assert.deepEqual(recent, { kinds: [30402], limit: 300 })
    assert.deepEqual(exact, { kinds: [30402], authors: [target.pubkey], '#d': ['old:shared-listing'], limit: 1 })
    socket.frame(['EVENT', id, signed({ identifier: 'new-1' })])
    socket.frame(['EVENT', id, signed({ identifier: 'new-2' })])
    socket.frame(['EVENT', id, target])
    assert.equal(client.records.size, 2)
    assert.equal(client.listings().some(item => item.id === targetId), true)
  } finally { client.close() }
  for (const invalid of ['', 'x', `${target.pubkey}:`, `${target.pubkey}:${'€'.repeat(54)}`, `bad:${target.id}`]) {
    assert.throws(() => new MarketRelayClient({ targetId: invalid }), /listing link/)
  }
})

test('offline refresh reconnects and closing the client prevents later socket events', () => {
  FakeSocket.sockets = []
  const states = []
  const client = new MarketRelayClient({ relays: ['wss://example.com'], WebSocketImpl: FakeSocket, now: () => now, onStatus: status => states.push(status.state) }).start()
  const original = FakeSocket.sockets[0]
  original.open()
  original.close()
  assert.equal(states.at(-1), 'offline')
  client.refresh()
  assert.equal(states.at(-1), 'connecting')
  const next = FakeSocket.sockets[1]
  next.open()
  const id = next.sent[0][1]
  next.frame(['EOSE', id])
  assert.equal(states.at(-1), 'live')
  client.close()
  next.frame(['EVENT', id, signed()])
  assert.equal(client.records.size, 0)
  assert.equal(states.at(-1), 'closed')
})

test('connection and subscription timeouts retry with backoff, and close cancels retries', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  FakeSocket.sockets = []
  const states = []
  const client = new MarketRelayClient({ relays: ['wss://example.com'], WebSocketImpl: FakeSocket, now: () => now, onStatus: status => states.push(status.state) }).start()
  try {
    t.mock.timers.tick(10000)
    assert.equal(states.at(-1), 'offline')
    t.mock.timers.tick(1000)
    assert.equal(FakeSocket.sockets.length, 2)
    assert.equal(states.at(-1), 'connecting')
    FakeSocket.sockets[1].open()
    t.mock.timers.tick(15000)
    assert.equal(states.at(-1), 'offline')
    t.mock.timers.tick(1999)
    assert.equal(FakeSocket.sockets.length, 2)
    t.mock.timers.tick(1)
    assert.equal(FakeSocket.sockets.length, 3)
    client.close()
    t.mock.timers.tick(60000)
    assert.equal(FakeSocket.sockets.length, 3)
    assert.equal(states.at(-1), 'closed')
  } finally { client.close() }
})


test('tag and author filters reach relays and reject noncompliant incoming inventory', () => {
  FakeSocket.sockets = []
  const match = signed({ extra: [['t', 'furniture']] })
  const authors = [match.pubkey], tags = ['furniture', 'lighting']
  const client = new MarketRelayClient({ relays: ['wss://example.com'], authors, tags, WebSocketImpl: FakeSocket, now: () => now }).start()
  authors.length = 0; tags[0] = 'unexpected mutation'
  try {
    const socket = FakeSocket.sockets[0]; socket.open()
    const [, id, filter] = socket.sent[0]
    assert.deepEqual(filter, { kinds: [30402], limit: 300, authors: [match.pubkey], '#t': ['furniture', 'lighting'] })
    socket.frame(['EVENT', id, signed({ identifier: 'wrong-tag', extra: [['t', 'Furniture']] })])
    socket.frame(['EVENT', id, signed({ identifier: 'wrong-author', extra: [['t', 'furniture']], key: generateSecretKey() })])
    assert.equal(client.records.size, 0)
    socket.frame(['EVENT', id, match])
    socket.frame(['EVENT', id, signed({ identifier: 'lamp', extra: [['t', 'lighting']] })])
    assert.equal(client.listings().length, 2)
    assert.equal(client.matchesFeed(client.listings()[0]), true)
  } finally { client.close() }
})

test('a newer revision leaving selected tags removes the old match and prevents stale replay', () => {
  FakeSocket.sockets = []
  const client = new MarketRelayClient({ relays: ['wss://example.com'], tags: ['Home'], WebSocketImpl: FakeSocket, now: () => now }).start()
  try {
    const socket = FakeSocket.sockets[0]; socket.open(); const id = socket.sent[0][1]
    const first = signed()
    socket.frame(['EVENT', id, first]); assert.equal(client.listings().length, 1)
    socket.frame(['EVENT', id, signed({ createdAt: now - 1, tags: [['d', 'chair'], ['title', 'Moved listing'], ['t', 'Other']] })])
    assert.equal(client.listings().length, 0)
    socket.frame(['EVENT', id, first]); assert.equal(client.listings().length, 0)
    assert.equal(client.records.size, 1)
  } finally { client.close() }
})

test('empty followed authors never trigger an unfiltered inventory query, including refresh', () => {
  FakeSocket.sockets = []
  const states = [], changes = [], records = new Map()
  applyEvent(records, signed(), { now })
  const client = new MarketRelayClient({ relays: ['wss://example.com'], authors: [], records,
    WebSocketImpl: FakeSocket, now: () => now, onStatus: value => states.push(value), onChange: rows => changes.push(rows) }).start()
  try {
    client.refresh()
    assert.equal(FakeSocket.sockets.length, 0)
    assert.deepEqual(client.listings(), [])
    assert.deepEqual(changes, [[]])
    assert.equal(states.at(-1).state, 'empty')
    assert.equal(states.at(-1).total, 0)
    assert.equal(client.expiryTimer, null)
  } finally { client.close() }
})

test('shared target lookup remains exact and works outside filters with empty followed authors', () => {
  FakeSocket.sockets = []
  const target = signed({ identifier: 'shared', extra: [['t', 'Furniture']] })
  const targetId = `${target.pubkey}:shared`
  const client = new MarketRelayClient({ relays: ['wss://example.com'], targetId, tags: ['unrelated'], authors: [],
    WebSocketImpl: FakeSocket, now: () => now }).start()
  try {
    const socket = FakeSocket.sockets[0]; socket.open()
    assert.equal(socket.sent[0].length, 3)
    const [, id, filter] = socket.sent[0]
    assert.deepEqual(filter, { kinds: [30402], authors: [target.pubkey], '#d': ['shared'], limit: 1 })
    socket.frame(['EVENT', id, signed({ identifier: 'unrequested' })])
    assert.equal(client.records.size, 0)
    socket.frame(['EVENT', id, target])
    assert.deepEqual(client.listings().map(item => item.id), [targetId])
    assert.equal(client.matchesFeed(client.listings()[0]), false)
  } finally { client.close() }
})

test('filter bounds and exact public author keys are validated before opening connections', () => {
  FakeSocket.sockets = []
  const key = signed().pubkey
  for (const options of [{ tags: null }, { tags: [''] }, { tags: Array(9).fill('Home') }, { tags: ['x'.repeat(61)] },
    { authors: 'everyone' }, { authors: ['npub-not-hex'] }, { authors: [key.toUpperCase()] }, { authors: Array(257).fill(key) }]) {
    assert.throws(() => new MarketRelayClient({ ...options, WebSocketImpl: FakeSocket }))
  }
  assert.equal(FakeSocket.sockets.length, 0)
  const unrestricted = new MarketRelayClient({ authors: null, tags: [] })
  assert.equal(unrestricted.matchesFeed(parseEvent(signed(), { now })), true)
})
