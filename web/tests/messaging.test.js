import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, matchFilters, nip19, verifyEvent } from 'nostr-tools';
import { AppKeys } from 'nostr-double-ratchet';
import { createVault } from '../src/messaging/vault.ts';
import { createMessaging, messageProjection, canPublishToDevice } from '../src/messaging/client.ts';
import { createPrivateTransport, verifiedPrivateEvent } from '../src/messaging/transport.ts';

function memoryBackend() {
  let row;
  return { read: async () => structuredClone(row), write: async (value, expected) => { if (expected !== undefined && (row?.version ?? 0) !== expected) throw new Error('Messages changed in another tab. Reload this page.'); row = structuredClone(value); } };
}
function memoryRelay() {
  const events = new Map(), subscriptions = new Set(), frames = [];
  const factory = () => {
    const own = new Set();
    let closed = false;
    return {
      subscribe(filters, { onEvent }) {
        const sub = { filters, onEvent }; own.add(sub); subscriptions.add(sub);
        queueMicrotask(() => { if (!closed) for (const event of events.values()) if (matchFilters(filters, event)) onEvent(structuredClone(event)); sub.replayed = true; });
        return { close: () => { own.delete(sub); subscriptions.delete(sub); } };
      },
      async query(filters) {
        return { events: [...events.values()].filter(event => matchFilters(filters, event)).map(event => structuredClone(event)), complete: true, sources: [{ id: 'wss://test.invalid', complete: true }] };
      },
      async publish(event) {
        assert.ok(verifyEvent(structuredClone(event))); frames.push(structuredClone(event)); events.set(event.id, structuredClone(event));
        for (const sub of subscriptions) if (matchFilters(sub.filters, event)) queueMicrotask(() => sub.onEvent(structuredClone(event)));
        return { remoteAccepted: true };
      },
      close() { closed = true; for (const sub of own) subscriptions.delete(sub); own.clear(); },
    };
  };
  return { factory, events, frames, subscriptions };
}
const waitFor = async predicate => {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
function client(bus, backend = memoryBackend()) {
  const vault = createVault({ backend });
  return { app: createMessaging({ getRelays: () => ['wss://test.invalid'], vault, transportFactory: bus.factory }), vault, backend };
}

test('device vault persists only authenticated ciphertext and a nonextractable browser key', async () => {
  const backend = memoryBackend(), vault = createVault({ backend });
  await vault.create({ secret: 'owner key', message: 'private message' });
  const row = await backend.read();
  assert.equal(row.key.extractable, false);
  assert.equal(JSON.stringify(row).includes('private message'), false);
  await assert.rejects(crypto.subtle.exportKey('raw', row.key));
  await Promise.all([vault.put('a', 1), vault.put('b', 2)]);
  vault.lock(); await assert.rejects(vault.get('secret'));
  await vault.unlock(); assert.equal(await vault.get('a'), 1); assert.equal(await vault.get('b'), 2);
  row.ciphertext = new Uint8Array([1, 2, 3]).buffer; await backend.write(row); vault.lock();
  await assert.rejects(vault.unlock(), /Could not open/);
});

test('optional passphrase vault contains no browser decryption key and rejects wrong passwords', async () => {
  const backend = memoryBackend(), vault = createVault({ backend });
  await vault.create({ secret: 'hidden' }, { password: 'correct horse battery' });
  assert.equal((await backend.read()).key, undefined);
  vault.lock(); await assert.rejects(vault.unlock('wrong password'), /Check your password/);
  await vault.unlock('correct horse battery'); assert.equal(await vault.get('secret'), 'hidden');
});

test('actual NDR runtimes exchange signed encrypted chat and retain conversation after restart', { timeout: 15_000 }, async t => {
  const bus = memoryRelay(), alice = client(bus), bob = client(bus);
  t.after(async () => { await alice.app.destroy(); await bob.app.destroy(); });
  await alice.app.createAccount(); await bob.app.createAccount();
  await waitFor(() => alice.app.state().canSend && bob.app.state().canSend);
  const aliceOwner = alice.app.state().ownerPubkey, bobOwner = bob.app.state().ownerPubkey;
  assert.notEqual(alice.app.state().devicePubkey, aliceOwner);
  assert.equal(alice.app.state().canSend, true);
  await alice.app.open(bobOwner);
  await alice.app.send(bobOwner, 'Is this still available?');
  await waitFor(() => bob.app.state().conversations.some(chat => chat.messages.some(message => message.text === 'Is this still available?')));
  const received = bob.app.state().conversations.find(chat => chat.pubkey === aliceOwner).messages[0];
  assert.equal(received.mine, false);
  await bob.app.send(aliceOwner, 'Yes, it is.');
  await waitFor(() => alice.app.state().conversations.some(chat => chat.messages.some(message => message.text === 'Yes, it is.')));
  assert.equal(bus.frames.some(event => event.content.includes('Is this still available?')), false);
  assert.ok(bus.frames.filter(event => event.kind === 1060).every(event => event.pubkey !== aliceOwner && event.pubkey !== bobOwner && event.tags.some(tag => tag[0] === 'v' && tag[1] === '2')));
  await bob.app.lock(); assert.equal(bob.app.state().conversations.length, 0);
  await bob.app.unlock(); assert.ok(bob.app.state().conversations.some(chat => chat.messages.some(message => message.text === 'Is this still available?')));
});

test('a second approved device receives new messages and revocation disables it', { timeout: 20_000 }, async t => {
  const bus = memoryRelay(), first = client(bus), second = client(bus), peer = client(bus);
  t.after(async () => { await first.app.destroy(); await second.app.destroy(); await peer.app.destroy(); });
  const ownerKey = generateSecretKey();
  await first.app.loginWithKey({ key: nip19.nsecEncode(ownerKey) });
  await waitFor(() => first.app.state().canSend);
  await second.app.loginWithKey({ key: nip19.nsecEncode(ownerKey) });
  await peer.app.createAccount();
  const owner = first.app.state().ownerPubkey;
  await waitFor(() => first.app.state().devices.length === 2 && first.app.state().canSend && second.app.state().canSend && peer.app.state().canSend);
  await peer.app.open(owner); await peer.app.send(owner, 'Hello both devices');
  await waitFor(() => [first, second].every(({ app }) => app.state().conversations.some(chat => chat.messages.some(message => message.text === 'Hello both devices'))));
  const peerOwner = peer.app.state().ownerPubkey;
  await first.app.send(peerOwner, 'Sent on sibling');
  await waitFor(() => second.app.state().conversations.some(chat => chat.pubkey === peerOwner && chat.messages.some(message => message.text === 'Sent on sibling' && message.mine)));
  const device = second.app.state().devicePubkey;
  await first.app.revokeDevice(device);
  await waitFor(() => !second.app.state().canSend);
  await assert.rejects(second.app.send(peer.app.state().ownerPubkey, 'Not allowed'), /not authorized/);
  await second.app.lock(); await second.app.unlock();
  await waitFor(() => second.app.state().chatStatus === 'revoked');
  assert.equal(second.app.state().canSend, false);
});

test('message projection uses authenticated owner metadata and routes sibling copies to the peer', () => {
  const owner = '1'.repeat(64), peer = '2'.repeat(64), device = '3'.repeat(64);
  const rumor = { kind: 14, id: '4'.repeat(64), pubkey: device, content: 'hello', tags: [['p', peer]], created_at: 123 };
  assert.equal(messageProjection(rumor, owner, { senderOwnerPubkey: owner, isSelf: true }, owner).pubkey, peer);
  assert.equal(messageProjection(rumor, device, { senderOwnerPubkey: peer }, owner).pubkey, peer);
  assert.equal(messageProjection({ ...rumor, tags: [['l', 'private-group']] }, peer, {}, owner), null);
});

test('private event validation discards cached signature flags on changed input', () => {
  const event = finalizeEvent({ kind: 1060, content: '', tags: [], created_at: 1 }, generateSecretKey());
  assert.ok(verifyEvent(event)); event.content = 'changed'; assert.equal(verifiedPrivateEvent(event), null);
});

test('transport rejects broad public identity discovery before opening any connection', () => {
  const transport = createPrivateTransport(() => ['wss://test.invalid'], { WebSocketImpl: class { constructor() { throw new Error('Should not open'); } } });
  assert.throws(() => transport.subscribe([{ kinds: [37368] }], { onEvent() {} }), /one author/);
  assert.throws(() => transport.subscribe([{ kinds: [30078], authors: ['1'.repeat(64), '2'.repeat(64)] }], { onEvent() {} }), /one author/);
  transport.close();
});


test('a stale second vault cannot overwrite a newer encrypted snapshot', async () => {
  const backend = memoryBackend(), first = createVault({ backend }), second = createVault({ backend });
  await first.create({ a: 1 }); await second.unlock();
  await first.put('a', 2); await assert.rejects(second.put('a', 3), /another tab/);
  second.lock(); await second.unlock(); assert.equal(await second.get('a'), 2);
});

test('failed registration resumes the same device key after restart without losing the account', async t => {
  const bus = memoryRelay(), backend = memoryBackend(), vault = createVault({ backend });
  let rejectRegistration = true;
  const transportFactory = () => {
    const transport = bus.factory(), publish = transport.publish;
    transport.publish = async event => event.kind === 37368 && rejectRegistration ? { remoteAccepted: false } : publish(event);
    return transport;
  };
  const app = createMessaging({ getRelays: () => ['wss://test.invalid'], vault, transportFactory });
  t.after(() => app.destroy());
  await app.loginWithKey({ key: nip19.nsecEncode(generateSecretKey()) });
  assert.equal(app.state().status, 'ready'); assert.equal(app.state().canSign, true);
  await waitFor(async () => Boolean((await vault.get('market/account')).proof));
  const pending = await vault.get('market/account');
  assert.ok(pending.proof); assert.equal(pending.installed, false);
  await app.lock(); assert.equal((await app.restore()).status, 'ready');
  assert.equal(app.state().devicePubkey, getPublicKey(Uint8Array.from(pending.deviceSecret)));
  rejectRegistration = false;
  await app.reconnect();
  await waitFor(() => app.state().canSend);
  assert.equal(app.state().ownerPubkey, pending.owner);
  assert.equal(app.state().devicePubkey, getPublicKey(Uint8Array.from(pending.deviceSecret)));
  assert.equal(app.state().canSend, true);
});

test('public posting signs the account identity and profile updates preserve existing fields', async t => {
  const bus = memoryRelay(), { app } = client(bus); t.after(() => app.destroy());
  await app.createAccount();
  const before = await app.publishEvent({ kind: 0, tags: [], created_at: 1, content: JSON.stringify({ name: 'Before', about: 'Keep me' }) });
  assert.equal(before.delivery, 'queued'); assert.deepEqual(before.accepted, []);
  await waitFor(() => bus.events.has(before.event.id) && app.state().pendingPublic === 0);
  const profileReceipt = await app.updateProfile({ name: 'Alice' });
  assert.equal(profileReceipt.delivery, 'queued'); assert.deepEqual(profileReceipt.accepted, []);
  await waitFor(() => bus.frames.some(event => event.kind === 0 && event.id !== before.event.id));
  const profile = bus.frames.find(event => event.kind === 0 && event.id !== before.event.id);
  assert.deepEqual(JSON.parse(profile.content), { name: 'Alice', about: 'Keep me', display_name: 'Alice' });
  const draft = { kind: 30402, created_at: 1, tags: [['d', 'test-listing'], ['title', 'A bicycle']], content: 'Test inventory' };
  const listingReceipt = await app.publishEvent(draft), listing = listingReceipt.event;
  assert.equal(listingReceipt.delivery, 'queued'); assert.deepEqual(listingReceipt.accepted, []);
  await waitFor(() => bus.frames.some(event => event.id === listing.id));
  assert.equal(listing.pubkey, app.state().ownerPubkey); assert.equal(verifyEvent(listing), true);
  await assert.rejects(app.publishEvent({ ...draft, kind: 1060 }), /public account/);
  assert.equal(JSON.stringify(app.state()).includes('ownerSecret'), false);
});

test('extension login keeps the owner key outside the vault and rejects a different posting signer', async t => {
  const bus = memoryRelay(), backend = memoryBackend(), vault = createVault({ backend }), ownerKey = generateSecretKey();
  let selected = ownerKey;
  const app = createMessaging({ getRelays: () => ['wss://test.invalid'], vault, transportFactory: bus.factory,
    extension: () => ({ getPublicKey: async () => getPublicKey(selected), signEvent: async draft => finalizeEvent(draft, selected) }) });
  t.after(() => app.destroy());
  await app.loginWithExtension();
  assert.equal((await vault.get('market/account')).ownerSecret, undefined);
  const device = app.state().devicePubkey;
  selected = generateSecretKey(); await assert.rejects(app.connectExtensionSigner(), /same account/);
  assert.equal(app.state().devicePubkey, device);
  selected = ownerKey; await app.connectExtensionSigner(); assert.equal(app.state().canSign, true);
});


test('queued ciphertext cannot be retried to a device removed by a newer peer roster', () => {
  const owner = '1'.repeat(64), device = '2'.repeat(64), event = { kind: 1060, tags: [['p', device]] };
  const context = { recipientOwnerPubkey: owner, createdAt: 1 };
  assert.equal(canPublishToDevice(event, context, [{ ownerPubkey: owner, appKeys: new AppKeys([{ identityPubkey: device, createdAt: 1 }]) }]), true);
  assert.equal(canPublishToDevice(event, context, [{ ownerPubkey: owner, appKeys: new AppKeys([]) }]), false);
});


test('a posting signer cannot mutate the draft being verified', async t => {
  const bus = memoryRelay(), key = generateSecretKey();
  let mutate = false;
  const app = createMessaging({ getRelays: () => ['wss://test.invalid'], vault: createVault({ backend: memoryBackend() }), transportFactory: bus.factory,
    extension: () => ({ getPublicKey: async () => getPublicKey(key), signEvent: async draft => { if (mutate) draft.content = 'Changed by signer'; return finalizeEvent(draft, key); } }) });
  t.after(() => app.destroy());
  await app.loginWithExtension(); mutate = true;
  await assert.rejects(app.publishEvent({ kind: 30402, tags: [], content: 'Original listing', created_at: 1 }), /Signer changed/);
  assert.equal(bus.frames.some(event => event.kind === 30402), false);
});


test('locking during a pending unlock prevents a late messaging runtime from reopening', async t => {
  const bus = memoryRelay(), backend = memoryBackend(), { app } = client(bus, backend);
  t.after(() => app.destroy());
  await app.createAccount(); await app.lock();
  const read = backend.read;
  let release, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  backend.read = async () => { entered(); await new Promise(resolve => { release = resolve; }); backend.read = read; return read(); };
  const unlocking = app.unlock(); await reading;
  const locking = app.lock(); release();
  await assert.rejects(unlocking, /Account changed/); await locking;
  assert.equal(app.state().status, 'locked'); assert.equal(app.state().canSend, false); assert.equal(app.state().ownerPubkey, undefined);
});


test('relay reconnection retains the same device and existing conversations', async t => {
  const bus = memoryRelay(), { app } = client(bus); t.after(() => app.destroy());
  await app.createAccount();
  await waitFor(() => app.state().canSend);
  const owner = app.state().ownerPubkey, device = app.state().devicePubkey;
  await app.open(owner); await app.reconnect();
  await waitFor(() => app.state().canSend);
  assert.equal(app.state().ownerPubkey, owner); assert.equal(app.state().devicePubkey, device);
  assert.equal(app.state().canSend, true); assert.ok(app.state().conversations.some(chat => chat.pubkey === owner));
});

test('an offline restored account waits for live signed authorization and resumes when it arrives', async t => {
  const bus = memoryRelay(), vault = createVault({ backend: memoryBackend() });
  let offline = false, deliverLive = false;
  const transportFactory = () => {
    const transport = bus.factory(), subscribe = transport.subscribe, query = transport.query;
    transport.subscribe = (filters, { onEvent }) => subscribe(filters, { onEvent: event => { if (!offline || deliverLive) onEvent(event); } });
    transport.query = filters => offline ? Promise.resolve({ events: [], complete: false, sources: [{ complete: false }] }) : query(filters);
    return transport;
  };
  const app = createMessaging({ getRelays: () => ['wss://test.invalid'], vault, transportFactory }); t.after(() => app.destroy());
  await app.createAccount(); await waitFor(() => app.state().canSend);
  const stored = await vault.get('market/account'), proof = stored.proof;
  await app.lock(); offline = true; await app.unlock(); assert.equal(app.state().canSend, false);
  await waitFor(() => [...bus.subscriptions].some(sub => sub.replayed && sub.filters.some(filter => filter.kinds?.includes(37368) && filter.authors?.includes(stored.owner))));
  deliverLive = true;
  await bus.factory().publish(finalizeEvent({ kind: 37368, created_at: proof.created_at + 1, tags: [['type', 'other_fact']], content: '' }, Uint8Array.from(stored.ownerSecret)));
  assert.equal(app.state().canSend, false);
  await bus.factory().publish(proof);
  await waitFor(() => app.state().canSend); assert.equal(app.state().status, 'ready');
});
