import test from 'node:test'
import assert from 'node:assert/strict'
import { AppKeys } from 'nostr-double-ratchet'
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, verifiedSymbol, verifyEvent } from 'nostr-tools'
import { RemoteSigner, parseBunkerLink, signerRelayUrls } from '../src/messaging/remote-signer.ts'
import { authorizeSignerDevice, fetchSignerRoster, prepareSignerAuthorization, selectSignerRoster, validateSignerAuthorization } from '../src/messaging/authorization.ts'

const relays = ['wss://signer.example/']
const ownerSecret = generateSecretKey(), owner = getPublicKey(ownerSecret)
const oldDevice = getPublicKey(generateSecretKey()), newDevice = getPublicKey(generateSecretKey())
const now = () => Math.floor(Date.now() / 1000)
const roster = (createdAt = now() - 1, device = oldDevice) => finalizeEvent(new AppKeys([{ identityPubkey: device, createdAt: 123 }]).getEvent({ ownerPubkey: owner, createdAt }), ownerSecret)
const freezeEvent = event => {
  event.tags.forEach(Object.freeze); Object.freeze(event.tags); return Object.freeze(event)
}
function rosterRuntime(events = []) {
  return {
    events, complete: true, sources: [{ id: relays[0], complete: true }], queries: [], publications: [], accepted: true,
    async query(filters, options) { this.queries.push({ filters, options }); return { events: this.events, complete: this.complete, sources: this.sources } },
    async publish(event, options) { this.publications.push({ event, options }); return { remoteAccepted: this.accepted } },
  }
}
function signerRuntime() {
  const transportSecret = generateSecretKey(), transportPubkey = getPublicKey(transportSecret)
  const state = {
    ...rosterRuntime(), transportPubkey, subscriptions: [], requests: [], handler: null, beforeReply: null,
    overrides: {}, linkInfo: undefined,
    subscribe(filters, handlers, options) {
      this.handler = handlers.onEvent
      const record = { filters, options, closed: false }; this.subscriptions.push(record)
      return { close: () => { record.closed = true } }
    },
    reply(client, id, result, error) {
      const conversation = nip44.v2.utils.getConversationKey(transportSecret, client)
      const event = finalizeEvent({ kind: 24133, created_at: now(), tags: [['p', client]], content: nip44.v2.encrypt(JSON.stringify({ id, result, ...(error && { error }) }), conversation) }, transportSecret)
      this.beforeReply?.(event, this.handler)
      this.handler(freezeEvent(event))
    },
    acceptConnection(link, secret) {
      const url = new URL(link)
      this.reply(url.hostname, crypto.randomUUID(), secret ?? url.searchParams.get('secret'))
    },
    async publish(event, options) {
      this.publications.push({ event, options })
      if (!this.accepted) return { remoteAccepted: false }
      if (event.kind === 37368) return { remoteAccepted: true }
      assert(verifyEvent({ ...event }))
      assert.equal(event.pubkey === owner, false)
      assert.equal(event.tags[0][1], transportPubkey)
      const request = JSON.parse(nip44.v2.decrypt(event.content, nip44.v2.utils.getConversationKey(transportSecret, event.pubkey)))
      this.requests.push(request)
      let result, error
      if (Object.hasOwn(this.overrides, request.method)) ({ result, error } = this.overrides[request.method])
      else if (request.method === 'connect') result = 'ack'
      else if (request.method === 'switch_relays') result = null
      else if (request.method === 'get_public_key') result = owner
      else if (request.method === 'sign_event') result = JSON.stringify(finalizeEvent(JSON.parse(request.params[0]), ownerSecret))
      else if (request.method === 'iris_get_link_info' && this.linkInfo) result = JSON.stringify(this.linkInfo)
      else error = 'Unsupported method'
      this.reply(event.pubkey, request.id, result, error)
      return { remoteAccepted: true }
    },
  }
  state.bunkerLink = `bunker://${transportPubkey}?relay=${encodeURIComponent(relays[0])}&secret=test-secret`
  return state
}
function clientFor(runtime, options = {}) {
  return new RemoteSigner({ runtime, relays, bunkerLink: runtime.bunkerLink, signal: new AbortController().signal, ...options })
}

test('signer links accept only bounded WebSocket relays and valid public keys', () => {
  assert.deepEqual(signerRelayUrls(['wss://relay.example', 'wss://relay.example/']), ['wss://relay.example/'])
  for (const link of ['https://example.org', 'bunker://broken?relay=wss://example.org', `bunker://${owner}?relay=https://example.org`, `bunker://${owner}?relay=wss://user:password@example.org`, `bunker://${owner}/path?relay=wss://example.org`]) assert.throws(() => parseBunkerLink(link))
  assert.throws(() => signerRelayUrls([]))
  assert.throws(() => signerRelayUrls(Array.from({ length: 9 }, (_, i) => `wss://relay${i}.example`)))
})

test('NIP-46 uses an ephemeral signed/encrypted channel and requests only roster permission', async () => {
  const runtime = signerRuntime(), client = clientFor(runtime)
  try {
    assert.equal(await client.connect(), owner)
    assert.notEqual(client.transportPubkey, owner)
    assert.notEqual(client.transportPubkey, runtime.transportPubkey)
    const connect = runtime.requests.find(request => request.method === 'connect')
    assert.equal(connect.params[2], 'sign_event:37368')
    assert.equal(JSON.parse(connect.params[3]).name, 'Iris Market')
    const expected = prepareSignerAuthorization(owner, newDevice, null)
    assert.equal(validateSignerAuthorization(expected, await client.signEvent(expected)).pubkey, owner)
    for (const { options } of runtime.publications) {
      assert.equal(options.queue, false); assert.equal(options.localEcho, false); assert.equal(options.requireAck, true); assert.deepEqual(options.sources, [])
    }
  } finally { client.close() }
  assert(runtime.subscriptions.every(subscription => subscription.closed))
})

test('unsupported relay negotiation is optional but explicit denial and unsafe relays fail', async () => {
  for (const [response, expectedError] of [[{ error: 'Unsupported method' }, null], [{ error: 'Denied by user' }, /declined/], [{ result: ['javascript:alert(1)'] }, /Invalid signer message server/], [{ result: ['wss://new.example'] }, null]]) {
    const runtime = signerRuntime(); runtime.overrides.switch_relays = response
    const client = clientFor(runtime)
    try { if (expectedError) await assert.rejects(client.connect(), expectedError); else assert.equal(await client.connect(), owner) }
    finally { client.close() }
  }
})

test('signer errors do not expose arbitrary peer text and optional link information is retained', async () => {
  const runtime = signerRuntime(), client = clientFor(runtime)
  try {
    await client.connect()
    runtime.overrides.sign_event = { error: 'database failed: /private/account-details' }
    await assert.rejects(client.signEvent(prepareSignerAuthorization(owner, newDevice, null)), error => error.message === 'Your other device could not approve this link. Try again.')
    delete runtime.overrides.sign_event
    runtime.linkInfo = { v: 1, device: newDevice, approver: oldDevice }
    await client.signEvent(prepareSignerAuthorization(owner, newDevice, null))
    assert.deepEqual(client.linkInfo, runtime.linkInfo)
  } finally { client.close() }
})

test('QR links preserve plus signs, require their challenge, and cancellation closes the channel', async () => {
  const runtime = signerRuntime(), controller = new AbortController()
  let connectionLink
  const client = clientFor(runtime, { bunkerLink: undefined, relays: ['wss://signer.example/one+two'], signal: controller.signal, onConnectionLink: link => { connectionLink = link } })
  const connected = client.connect()
  try {
    await Promise.resolve(); await Promise.resolve()
    assert(connectionLink.includes('name=Iris%20Market'))
    assert(connectionLink.includes('%2B')); assert(!connectionLink.includes('+'))
    runtime.acceptConnection(connectionLink, 'wrong-challenge')
    assert.equal(runtime.requests.length, 0)
    runtime.acceptConnection(connectionLink)
    assert.equal(await connected, owner)
    controller.abort()
    assert.throws(() => client.ensureActive(), /cancelled/)
  } finally { client.close(); await connected.catch(() => {}) }
})

test('forged verification flags and malformed relay events cannot authorize a signer response', async () => {
  const runtime = signerRuntime()
  let forged = 0
  runtime.beforeReply = (event, handler) => {
    handler(null); handler({ tags: [null], content: '' })
    handler(freezeEvent({ ...event, sig: '0'.repeat(128), [verifiedSymbol]: true })); forged++
  }
  const client = clientFor(runtime)
  try { assert.equal(await client.connect(), owner); assert(forged > 0) }
  finally { client.close() }
})

test('rejected signer publications surface a connection error instead of waiting', async () => {
  const runtime = signerRuntime(); runtime.accepted = false
  const client = clientFor(runtime)
  try { await assert.rejects(client.connect(), /Could not reach signer/) }
  finally { client.close() }
})

test('rosters use AppKeys current schema, retain devices, and omit old encrypted names', () => {
  const previous = roster()
  const labeled = finalizeEvent({ ...previous, tags: [...previous.tags, ['encrypted_device_labels', 'old-private-labels']] }, ownerSecret)
  const expected = prepareSignerAuthorization(owner, newDevice, labeled)
  assert.equal(expected.kind, 37368)
  assert.equal(expected.content, '')
  assert(expected.tags.some(tag => tag[0] === 'type' && tag[1] === 'app_keys_roster_snapshot'))
  assert(!expected.tags.some(tag => tag[0] === 'encrypted_device_labels' || tag[0] === 'f' && tag[1] === 'encrypted_device_labels'))
  assert.notEqual(expected.tags.find(tag => tag[0] === 'd')[1], previous.tags.find(tag => tag[0] === 'd')[1])
  const devices = AppKeys.fromEvent(validateSignerAuthorization(expected, finalizeEvent(expected, ownerSecret))).getAllDevices()
  assert(devices.some(device => device.identityPubkey === oldDevice && device.createdAt === 123))
  assert(devices.some(device => device.identityPubkey === newDevice))
})

test('authorization validates exact requested fields and independently verifies frozen signatures', () => {
  const previous = freezeEvent(roster()), expected = prepareSignerAuthorization(owner, newDevice, previous)
  const signed = freezeEvent(finalizeEvent(expected, ownerSecret))
  assert.notEqual(validateSignerAuthorization(expected, signed), signed)
  assert.equal(selectSignerRoster([previous], owner).id, previous.id)
  for (const forged of [finalizeEvent({ ...expected, content: 'changed' }, ownerSecret), finalizeEvent({ ...expected }, generateSecretKey())]) assert.throws(() => validateSignerAuthorization(expected, forged), /changed/)
  const bad = freezeEvent({ ...signed, sig: '0'.repeat(128), [verifiedSymbol]: true })
  assert.throws(() => validateSignerAuthorization(expected, bad), /signature/)
  assert.throws(() => selectSignerRoster([bad], owner), /signature/)
  assert.throws(() => prepareSignerAuthorization(owner, newDevice, bad), /signature/)
  assert.throws(() => prepareSignerAuthorization(newDevice, oldDevice, previous), /Invalid/)
})

test('roster lookup keeps competing heads, partial newer data, and fails closed on incomplete absence', async () => {
  const old = roster(now() - 2), latest = roster(now() - 1, newDevice), runtime = rosterRuntime([old])
  runtime.complete = false; runtime.sources.push({ id: 'offline', complete: false })
  const lookup = () => fetchSignerRoster(owner, relays, new AbortController().signal, runtime)
  assert.equal((await lookup()).id, old.id)
  runtime.events = [old, latest, latest]
  assert.equal((await lookup()).id, latest.id)
  assert.equal(runtime.queries[0].options.includeSuperseded, true)
  assert.equal(runtime.queries[0].options.cache, 'network-only')
  runtime.events.push(roster(latest.created_at))
  await assert.rejects(lookup(), /Conflicting/)
  runtime.events = []
  await assert.rejects(lookup(), /Could not check/)
  runtime.events = [latest]; runtime.sources.forEach(source => { source.complete = false })
  await assert.rejects(lookup(), /Could not check/)
  runtime.complete = true; runtime.events = []
  assert.equal(await lookup(), null)
})

test('invalid or oversized device lists are rejected before authorizing another device', async () => {
  assert.throws(() => selectSignerRoster([roster(now() + 301)], owner), /Invalid/)
  const bad = roster(); bad.tags = bad.tags.map(tag => tag[0] === 'device' ? ['device', 'broken', '123'] : tag)
  assert.throws(() => selectSignerRoster([finalizeEvent(bad, ownerSecret)], owner), /Invalid/)
  const runtime = rosterRuntime(Array(1024).fill(roster()))
  await assert.rejects(fetchSignerRoster(owner, relays, new AbortController().signal, runtime), /too large/)
})

test('device key and signed proof can be saved before publication, preserving existing devices', async () => {
  const runtime = rosterRuntime([roster()]), order = [], signal = new AbortController().signal
  const query = runtime.query.bind(runtime)
  runtime.query = async (...args) => { order.push('lookup'); return query(...args) }
  const publish = runtime.publish.bind(runtime)
  runtime.publish = async (...args) => { order.push('publish'); return publish(...args) }
  let storedKey, storedEvent
  const result = await authorizeSignerDevice({ owner, relays, signal, runtime,
    signEvent: async event => { order.push('sign'); return finalizeEvent(event, ownerSecret) },
    onPrepared: async ({ event, deviceSecret }) => { order.push('prepare'); await Promise.resolve(); storedKey = deviceSecret.slice(); storedEvent = event },
    onCommitting: () => { order.push('commit') },
  })
  assert.deepEqual(order, ['lookup', 'sign', 'prepare', 'lookup', 'commit', 'publish'])
  assert.deepEqual(result.deviceSecret, storedKey); assert.equal(result.event.id, storedEvent.id)
  assert(AppKeys.fromEvent(result.event).getDevice(getPublicKey(result.deviceSecret)))
  assert(AppKeys.fromEvent(result.event).getDevice(oldDevice))
  assert.equal(runtime.publications[0].options.queue, false)
  result.deviceSecret.fill(0); storedKey.fill(0)
})

test('failed storage and cancellation before publication wipe transient keys and publish nothing', async () => {
  for (const failure of ['storage', 'cancel']) {
    const runtime = rosterRuntime(), controller = new AbortController()
    let temporaryKey
    await assert.rejects(authorizeSignerDevice({ owner, relays, runtime, signal: controller.signal,
      signEvent: async event => finalizeEvent(event, ownerSecret),
      onPrepared: async ({ deviceSecret }) => { temporaryKey = deviceSecret; if (failure === 'storage') throw new Error('Storage full'); controller.abort() },
    }))
    assert.equal(runtime.publications.length, 0)
    assert(temporaryKey.every(byte => byte === 0))
  }
})

test('roster races prevent publication and cancellation after committing retains the accepted key', async () => {
  const previous = roster(), runtime = rosterRuntime([previous])
  await assert.rejects(authorizeSignerDevice({ owner, relays, runtime, signal: new AbortController().signal,
    signEvent: async event => finalizeEvent(event, ownerSecret),
    onPrepared: async () => { runtime.events = [roster(previous.created_at + 1, newDevice)] },
  }), /device list changed/)
  assert.equal(runtime.publications.length, 0)
  const controller = new AbortController(), accepted = rosterRuntime()
  const result = await authorizeSignerDevice({ owner, relays, runtime: accepted, signal: controller.signal,
    signEvent: async event => finalizeEvent(event, ownerSecret), onCommitting: () => controller.abort(),
  })
  assert.equal(accepted.publications.length, 1)
  assert(result.deviceSecret.some(byte => byte !== 0))
  result.deviceSecret.fill(0)
})


test('a signer cannot mutate the requested roster to change what validation approves', async () => {
  const runtime = rosterRuntime([roster()])
  await assert.rejects(authorizeSignerDevice({ owner, relays, runtime, signal: new AbortController().signal,
    signEvent: async event => {
      event.tags = event.tags.filter(tag => tag[0] !== 'device' || tag[1] !== oldDevice)
      return finalizeEvent(event, ownerSecret)
    },
  }), /changed/)
  assert.equal(runtime.publications.length, 0)
})


test('failed onboarding retries the same saved key without mutating the caller buffer', async () => {
  const saved = generateSecretKey(), original = saved.slice(), device = getPublicKey(saved)
  const runtime = rosterRuntime([roster()]); runtime.accepted = false
  let failedKey
  await assert.rejects(authorizeSignerDevice({ owner, relays, runtime, deviceSecret: saved, signal: new AbortController().signal,
    signEvent: async event => finalizeEvent(event, ownerSecret),
    onPrepared: ({ deviceSecret }) => { failedKey = deviceSecret },
  }), /Could not save/)
  assert(failedKey.every(byte => byte === 0)); assert.deepEqual(saved, original)
  runtime.accepted = true
  const retry = await authorizeSignerDevice({ owner, relays, runtime, deviceSecret: saved, signal: new AbortController().signal,
    signEvent: async event => finalizeEvent(event, ownerSecret),
  })
  assert.equal(getPublicKey(retry.deviceSecret), device)
  assert(AppKeys.fromEvent(retry.event).getDevice(device))
  assert.notEqual(retry.deviceSecret, saved)
  retry.deviceSecret.fill(0); assert.deepEqual(saved, original); saved.fill(0); original.fill(0)
})

test('an already approved saved device reuses the newest verified roster without another signature', async () => {
  const saved = generateSecretKey(), device = getPublicKey(saved)
  const older = roster(now() - 2, device)
  const keys = AppKeys.fromEvent(older); keys.addDevice({ identityPubkey: newDevice, createdAt: now() - 1 })
  const newer = finalizeEvent(keys.getEvent({ ownerPubkey: owner, createdAt: now() - 1 }), ownerSecret)
  const runtime = rosterRuntime([older, newer]), order = []
  const result = await authorizeSignerDevice({ owner, relays, runtime, deviceSecret: saved, signal: new AbortController().signal,
    signEvent: async () => { throw new Error('Must not sign again') },
    onAuthorized: (event, key) => { assert.equal(event.id, newer.id); assert.equal(key, device); order.push('authorized') },
    onPrepared: async ({ event, deviceSecret }) => { assert.equal(event.id, newer.id); assert.deepEqual(deviceSecret, saved); order.push('prepared') },
    onCommitting: () => order.push('committing'),
  })
  assert.deepEqual(order, ['authorized', 'prepared', 'committing'])
  assert.equal(result.event.id, newer.id); assert.equal(runtime.publications.length, 0)
  assert(AppKeys.fromEvent(result.event).getDevice(newDevice))
  result.deviceSecret.fill(0); saved.fill(0)
})

test('invalid saved keys are rejected before querying or signing', async () => {
  const runtime = rosterRuntime()
  for (const deviceSecret of [[], new Uint8Array(31), new Uint8Array(32)]) {
    await assert.rejects(authorizeSignerDevice({ owner, relays, runtime, deviceSecret, signal: new AbortController().signal, signEvent: () => { throw new Error('Must not sign') } }))
  }
  assert.equal(runtime.queries.length, 0)
})


test('public signing is explicitly scoped and never fetches private device-link information', async () => {
  const runtime = signerRuntime(), permissions = ['sign_event:0', 'sign_event:3', 'sign_event:30402']
  let closed = 0
  const client = clientFor(runtime, { permissions, timeoutMs: 15 * 60 * 1000, onClose: () => { closed++ } })
  try {
    assert.equal(await client.connect(), owner)
    assert.equal(runtime.requests[0].params[2], permissions.join(','))
    const signed = await client.signEvent({ pubkey: owner, kind: 30402, created_at: now(), tags: [['d', 'listing']], content: 'A public listing' })
    assert.equal(signed.kind, 30402)
    assert.equal(runtime.requests.some(request => request.method === 'iris_get_link_info'), false)
    const count = runtime.publications.length
    await assert.rejects(client.signEvent(prepareSignerAuthorization(owner, newDevice, null)), /cannot approve/)
    assert.equal(runtime.publications.length, count)
  } finally { client.close(); client.close() }
  assert.equal(closed, 1)
})

test('default device authorization cannot sign public posts and arbitrary scopes are rejected', async () => {
  const runtime = signerRuntime(), client = clientFor(runtime)
  try { await assert.rejects(client.signEvent({ kind: 30402 }), /cannot approve/); assert.equal(runtime.publications.length, 0) }
  finally { client.close() }
  for (const permissions of [[], ['sign_event'], ['sign_event:1'], ['sign_event:37368'], ['nip44_decrypt']]) {
    assert.throws(() => clientFor(runtime, { permissions }), /Unsupported signer permissions/)
  }
})
