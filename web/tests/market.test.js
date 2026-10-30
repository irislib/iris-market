import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { parseEvent, applyEvent, visibleListings, validateRelays, MarketRelayClient } from '../src/market.ts'

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

test('map coordinates come only from verified geohash tags, never location text', () => {
  const mapped = parseEvent(signed({ extra: [['g', 'u6'], ['g', 'u60sc']] }), { now })
  assert.equal(mapped.geohash, 'u60sc')
  assert.equal(mapped.coordinates.length, 2)
  assert.equal(mapped.locationBounds.length, 4)
  assert(Object.isFrozen(mapped.coordinates))
  const plain = parseEvent(signed(), { now })
  assert.equal(plain.coordinates, null)
  const invalid = parseEvent(signed({ extra: [['g', 'not a coordinate']] }), { now })
  assert.equal(invalid.geohash, null)
  const forged = signed({ extra: [['g', 'u60sc']] }); forged.tags.push(['g', 'u60scx'])
  assert.throws(() => parseEvent(forged, { now }), /signature/)
})

const turn = () => new Promise(resolve => setImmediate(resolve))
const openHistory = socket => { socket.open(); return socket.sent.find(frame => frame[0] === 'REQ') }

test('older pages use each relay verified cursor, exclude exact targets, and preserve live subscriptions', async () => {
  FakeSocket.sockets = []
  const shared = signed({ identifier: 'shared-old', createdAt: now - 10000 })
  const recent = signed({ identifier: 'recent', createdAt: now - 10 })
  const boundary = signed({ identifier: 'boundary', createdAt: now - 20 })
  const client = new MarketRelayClient({ relays: ['wss://one.example','wss://two.example'], targetId: `${shared.pubkey}:shared-old`, historyPageSize: 2, maxRecords: 20, WebSocketImpl: FakeSocket, now: () => now }).start()
  try {
    const live = [...FakeSocket.sockets]
    for (const [index, socket] of live.entries()) {
      socket.open(); const subscription = socket.sent[0][1]
      if (index === 0) socket.frame(['EVENT', subscription, recent])
      socket.frame(['EVENT', subscription, boundary])
      socket.frame(['EVENT', subscription, shared])
      const forged = JSON.parse(JSON.stringify(signed({ createdAt: now - 50000 }))); forged.sig = '0'.repeat(128)
      socket.frame(['EVENT', subscription, forged]); socket.frame(['EOSE', subscription])
    }
    const pending = client.loadOlder(); assert.equal(client.loadOlder(), pending); await turn()
    const pages = FakeSocket.sockets.slice(2)
    for (const [index, socket] of pages.entries()) {
      const [, subscription, filter] = openHistory(socket)
      assert.deepEqual(filter, { kinds: [30402], until: now - 20, limit: 2 })
      socket.frame(['EVENT', subscription, boundary])
      socket.frame(['EVENT', subscription, signed({ identifier: `older-${index}`, createdAt: now - 30 - index * 10 })])
      socket.frame(['EOSE', subscription])
    }
    const result = await pending
    assert.equal(result.added, 2); assert.equal(result.hasMore, true); assert.equal(result.exhausted, false)
    assert(live.every(socket => socket.readyState === 1 && socket.sent.length === 1))
    assert(pages.every(socket => socket.readyState === 3 && socket.sent.at(-1)[0] === 'CLOSE'))
    live[0].frame(['EVENT', live[0].sent[0][1], signed({ identifier: 'older-0', status: 'sold', createdAt: now - 1 })])
    assert.equal(client.listings().some(item => item.identifier === 'older-0'), false)
    const final = client.loadOlder(); await turn()
    for (const [index, socket] of FakeSocket.sockets.slice(4).entries()) {
      const [, subscription, filter] = openHistory(socket)
      assert.equal(filter.until, now - 30 - index * 10)
      socket.frame(['EOSE', subscription])
    }
    assert.equal((await final).exhausted, true); assert.equal(client.pagination().hasMore, false)
  } finally { client.close() }
})

test('partial initial inventory stays visible without skipping its unconfirmed interval', async () => {
  FakeSocket.sockets = []
  const client = new MarketRelayClient({ relays: ['wss://one.example'], historyPageSize: 2, WebSocketImpl: FakeSocket, now: () => now }).start()
  try {
    const live = FakeSocket.sockets[0]; live.open()
    live.frame(['EVENT', live.sent[0][1], signed({ identifier: 'early-outlier', createdAt: now - 50000 })])
    assert.equal(client.listings().length, 1)
    const pending = client.loadOlder(); await turn()
    const page = FakeSocket.sockets[1], [, id, filter] = openHistory(page)
    assert.equal(filter.until, now)
    page.frame(['EVENT', id, signed({ identifier: 'newer-match', createdAt: now - 10 })])
    assert.equal(client.listings().length, 2)
    page.frame(['EOSE', id]); await pending
  } finally { client.close() }
})

test('a full same-second page expands inclusively before moving to older timestamps', async () => {
  FakeSocket.sockets = []
  const items = [0,1,2].map(i => signed({ identifier: `same-${i}`, createdAt: now - 20 }))
  const older = signed({ identifier: 'older', createdAt: now - 21 })
  const client = new MarketRelayClient({ relays: ['wss://one.example'], historyPageSize: 2, maxRecords: 20, WebSocketImpl: FakeSocket, now: () => now }).start()
  try {
    const live = FakeSocket.sockets[0]; live.open(); const subscription = live.sent[0][1]
    for (const item of items.slice(0,2)) live.frame(['EVENT', subscription, item])
    live.frame(['EOSE', subscription])
    const pending = client.loadOlder(); await turn()
    const first = FakeSocket.sockets[1], [, firstId, firstFilter] = openHistory(first)
    assert.equal(firstFilter.until, now - 20); assert.equal(firstFilter.limit, 2)
    for (const item of items.slice(0,2)) first.frame(['EVENT', firstId, item])
    first.frame(['EOSE', firstId]); await turn()
    const second = FakeSocket.sockets[2], [, secondId, secondFilter] = openHistory(second)
    assert.equal(secondFilter.until, now - 20); assert.equal(secondFilter.limit, 4)
    for (const item of [...items, older]) second.frame(['EVENT', secondId, item])
    second.frame(['EOSE', secondId])
    const result = await pending
    assert.equal(result.exhausted, false); assert.equal(result.added, 2); assert.equal(client.records.size, 4)
    assert.equal(client.history.values().next().value.cursor, now - 21)
  } finally { client.close() }
})

test('dense boundary progress survives the bounded loading window', async () => {
  FakeSocket.sockets = []
  const items = Array.from({length: 10}, (_, i) => signed({identifier: `dense-${i}`, createdAt: now - 20}))
  const client = new MarketRelayClient({relays:['wss://one.example'], historyPageSize:1, maxRecords:100, WebSocketImpl:FakeSocket, now:()=>now}).start()
  try {
    const live = FakeSocket.sockets[0]; live.open()
    live.frame(['EVENT', live.sent[0][1], items[0]]); live.frame(['EOSE', live.sent[0][1]])
    const firstWindow = client.loadOlder(); await turn()
    for (let round = 0; round < 4; round++) {
      const socket = FakeSocket.sockets[round + 1], [, id, filter] = openHistory(socket)
      assert.equal(filter.limit, 2 ** round)
      for (const item of items.slice(0, filter.limit)) socket.frame(['EVENT', id, item])
      socket.frame(['EOSE', id]); await turn()
    }
    assert.equal((await firstWindow).hasMore, true)
    const nextWindow = client.loadOlder(); await turn()
    const socket = FakeSocket.sockets[5], [, id, filter] = openHistory(socket)
    assert.equal(filter.until, now - 20); assert.equal(filter.limit, 16)
    for (const item of items) socket.frame(['EVENT', id, item])
    socket.frame(['EVENT', id, signed({identifier:'past-boundary', createdAt:now - 21})])
    socket.frame(['EOSE', id]); await nextWindow
    assert.equal(client.listings().some(item => item.identifier === 'past-boundary'), true)
  } finally { client.close() }
})

test('short boundary overlap checks the earlier second before declaring exhaustion', async () => {
  FakeSocket.sockets = []
  const item = signed({ createdAt: now - 20 })
  const client = new MarketRelayClient({ relays: ['wss://one.example'], historyPageSize: 2, WebSocketImpl: FakeSocket, now: () => now }).start()
  try {
    const live = FakeSocket.sockets[0]; live.open(); live.frame(['EVENT', live.sent[0][1], item]); live.frame(['EOSE', live.sent[0][1]])
    const pending = client.loadOlder(); await turn()
    const first = FakeSocket.sockets[1], [, id] = openHistory(first)
    first.frame(['EVENT', id, item]); first.frame(['EOSE', id]); await turn()
    assert.equal(client.pagination().exhausted, false)
    const next = FakeSocket.sockets[2], [, nextId, filter] = openHistory(next)
    assert.equal(filter.until, now - 21)
    next.frame(['EOSE', nextId]); assert.equal((await pending).exhausted, true)
  } finally { client.close() }
})

test('history timeouts keep the cursor retryable and do not reconnect or close the live stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout','setInterval'] })
  FakeSocket.sockets = []
  const client = new MarketRelayClient({ relays: ['wss://one.example'], historyPageSize: 2, WebSocketImpl: FakeSocket, now: () => now }).start()
  try {
    const live = FakeSocket.sockets[0]; live.open(); const liveId = live.sent[0][1]
    live.frame(['EVENT', liveId, signed()]); live.frame(['EOSE', liveId])
    const pending = client.loadOlder(); await turn()
    const first = FakeSocket.sockets[1], [, id] = openHistory(first)
    const old = signed({ identifier: 'older', createdAt: now - 30 })
    first.frame(['EVENT', id, old]); t.mock.timers.tick(12000)
    const failed = await pending
    assert(failed.error); assert.equal(failed.hasMore, true); assert.equal(failed.exhausted, false)
    assert.equal(live.readyState, 1); assert.equal(live.sent.length, 1); assert.equal(first.sent.at(-1)[0], 'CLOSE')
    const retry = client.loadOlder(); await turn()
    const next = FakeSocket.sockets[2], [, nextId, filter] = openHistory(next)
    assert.equal(filter.until, now - 20)
    next.frame(['EVENT', nextId, old]); next.frame(['EOSE', nextId])
    assert.equal((await retry).error, ''); assert.equal(client.records.size, 2)
  } finally { client.close() }
})

test('invalid older events never advance the cursor or establish exhausted coverage', async () => {
  FakeSocket.sockets = []
  const client = new MarketRelayClient({ relays: ['wss://one.example'], WebSocketImpl: FakeSocket, now: () => now }).start()
  try {
    const live = FakeSocket.sockets[0]; live.open(); live.frame(['EVENT', live.sent[0][1], signed()]); live.frame(['EOSE', live.sent[0][1]])
    const pending = client.loadOlder(); await turn()
    const socket = FakeSocket.sockets[1], [, id] = openHistory(socket)
    const forged = JSON.parse(JSON.stringify(signed({ identifier: 'forged', createdAt: now - 500 })));
    forged.content = 'changed'
    socket.frame(['EVENT', id, forged]); socket.frame(['EOSE', id])
    const result = await pending
    assert(result.error); assert.equal(result.exhausted, false); assert.equal(result.hasMore, true)
    assert.equal(client.records.size, 1); assert.equal(client.history.values().next().value.cursor, now - 20)
  } finally { client.close() }
})

test('history capacity keeps tombstones and reports a limit rather than exhaustion', async () => {
  FakeSocket.sockets = []
  const client = new MarketRelayClient({ relays: ['wss://one.example'], maxRecords: 2, WebSocketImpl: FakeSocket, now: () => now }).start()
  try {
    const live = FakeSocket.sockets[0]; live.open(); live.frame(['EVENT', live.sent[0][1], signed({ status: 'sold' })]); live.frame(['EOSE', live.sent[0][1]])
    const pending = client.loadOlder(); await turn()
    const socket = FakeSocket.sockets[1], [, id] = openHistory(socket)
    socket.frame(['EVENT', id, signed({ createdAt: now - 30 })])
    socket.frame(['EVENT', id, signed({ identifier: 'lamp', createdAt: now - 40 })])
    const result = await pending
    assert.equal(result.limited, true); assert.equal(result.exhausted, false); assert.equal(result.hasMore, false)
    assert.equal(client.records.size, 2); assert.deepEqual(client.listings().map(item => item.identifier), ['lamp'])
    assert.equal(socket.readyState, 3)
    const count = FakeSocket.sockets.length; await client.loadOlder(); assert.equal(FakeSocket.sockets.length, count)
  } finally { client.close() }
})

test('closing stops pending older reads and empty follow filters never open history sockets', async () => {
  FakeSocket.sockets = []
  const client = new MarketRelayClient({ relays: ['wss://one.example'], WebSocketImpl: FakeSocket, now: () => now }).start()
  const pending = client.loadOlder(); await turn()
  const page = FakeSocket.sockets[1]; openHistory(page)
  client.close(); await pending
  assert.equal(page.readyState, 3); assert.equal(client.historyReaders.size, 0); assert.equal(client.pagination().loading, false)
  const empty = new MarketRelayClient({ relays: ['wss://one.example'], authors: [], WebSocketImpl: FakeSocket })
  const count = FakeSocket.sockets.length
  empty.start(); assert.equal((await empty.loadOlder()).hasMore, false); assert.equal(FakeSocket.sockets.length, count); empty.close()
})
