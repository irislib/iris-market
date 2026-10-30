// Test-only wire interoperability harness. Generated keys never leave the fixture directory.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { AppKeys, NdrRuntime, buildReactionRumor, buildReceiptRumor, parseReaction, parseReceipt } from 'nostr-double-ratchet';
import { finalizeEvent, generateSecretKey, getPublicKey, matchFilter, verifyEvent } from 'nostr-tools';

const [directory, phase] = process.argv.slice(2);
if (!directory || !['bootstrap', 'reply', 'verify'].includes(phase)) throw new Error('Usage: ndr-interop.mjs <fixture directory> bootstrap|reply|verify');
const read = file => readFile(path.join(directory, file), 'utf8').then(JSON.parse);
const write = (file, value) => writeFile(path.join(directory, file), JSON.stringify(value), { mode: 0o600 });
const state = phase === 'bootstrap' ? { ownerSecret: [...generateSecretKey()], deviceSecret: [...generateSecretKey()], entries: [], received: [] } : await read('js-state.json');
const ownerSecret = Uint8Array.from(state.ownerSecret), deviceSecret = Uint8Array.from(state.deviceSecret);
const owner = getPublicKey(ownerSecret), device = getPublicKey(deviceSecret), createdAt = Math.floor(Date.now() / 1000);
if (!state.authorization) state.authorization = finalizeEvent(new AppKeys([{ identityPubkey: device, createdAt }]).getEvent({ ownerPubkey: owner, createdAt }), ownerSecret);
const entries = new Map(state.entries), subscriptions = new Set(), outgoing = new Map();
for (const [key, value] of [['identity-public-key', device], ['identity-private-key', [...deviceSecret]], ['owner-pubkey', owner]]) entries.set(`v1/device-manager/${key}`, value);
const storage = { get: async key => structuredClone(entries.get(key)), put: async (key, value) => { entries.set(key, structuredClone(value)); }, del: async key => { entries.delete(key); }, list: async prefix => [...entries.keys()].filter(key => key.startsWith(prefix)) };
const rust = phase === 'bootstrap' ? null : await read(phase === 'reply' ? 'rust-output-1.json' : 'rust-output-2.json');
const incoming = rust?.outgoing ?? [];
const runtime = new NdrRuntime({ storage, appKeysFetchTimeoutMs: 200, appKeysFastTimeoutMs: 100,
  nostrSubscribe(filter, onEvent) {
    const sub = { filter, onEvent }; subscriptions.add(sub);
    queueMicrotask(() => { for (const event of incoming) if (matchFilter(filter, event)) onEvent(structuredClone(event)); });
    return () => subscriptions.delete(sub);
  },
  nostrFetch: async filter => incoming.filter(event => matchFilter(filter, event)).map(event => structuredClone(event)),
  nostrSign: async event => finalizeEvent(event, ownerSecret),
  nostrPublish: async event => { const signed = event.sig ? event : finalizeEvent(event, ownerSecret); assert(verifyEvent(structuredClone(signed))); outgoing.set(signed.id, signed); return signed; },
});
state.rumors ??= [];
runtime.onDurableSessionEvent([14, 7, 15], async rumor => {
  if (!state.rumors.some(item => item.id === rumor.id)) state.rumors.push(rumor);
  if (rumor.kind === 14 && !state.received.includes(rumor.content)) state.received.push(rumor.content);
});
let nativeHello, webHello;
try {
  await runtime.initManagers();
  const manager = await runtime.initSessionManager(owner);
  const own = manager.getKnownAppKeysSnapshots().find(snapshot => snapshot.ownerPubkey === owner);
  if (own) await runtime.applyTrustedAppKeysSnapshot(own);
  await runtime.applyVerifiedAppKeysEvent(state.authorization);
  await runtime.initForOwner(owner);
  await runtime.republishInvite();
  if (rust) {
    for (const event of incoming) {
      assert(verifyEvent(structuredClone(event)));
      for (const subscription of subscriptions) if (matchFilter(subscription.filter, event)) subscription.onEvent(structuredClone(event));
      runtime.feedEvent(structuredClone(event));
    }
    const expected = phase === 'reply' ? 'Hello from native Market' : 'Native reply received';
    const deadline = Date.now() + 5000;
    while (!state.received.includes(expected) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert(state.received.includes(expected), `Missing Rust message: ${expected}`);
    if (phase === 'reply') {
      await runtime.setupUser(rust.owner_public_key);
      nativeHello = state.rumors.find(item => item.kind === 14 && item.content === expected);
      assert(nativeHello?.id);
      webHello = await runtime.sendMessage(rust.owner_public_key, 'Hello from web Market');
      state.webHelloId = webHello.id;
      state.boundaryMessageIds = [webHello.id];
      for (let index = 1; index < 256; index++) {
        const message = await runtime.sendMessage(rust.owner_public_key, `Receipt boundary message ${index}`);
        state.boundaryMessageIds.push(message.id);
      }
      assert.equal(new Set(state.boundaryMessageIds).size, 256);
      for (const type of ['delivered', 'seen']) await runtime.sendEvent(rust.owner_public_key, buildReceiptRumor(type, [nativeHello.id], { pubkey: device, nowMs: Date.now(), tags: [['p', rust.owner_public_key]] }));
      await runtime.sendEvent(rust.owner_public_key, buildReactionRumor(nativeHello.id, '🇫🇮', { pubkey: device, nowMs: Date.now(), tags: [['p', rust.owner_public_key]] }));
    } else {
      const seenBatches = () => state.rumors.map(item => parseReceipt(item)).filter(receipt => receipt?.type === 'seen' && receipt.messageIds.some(id => state.boundaryMessageIds.includes(id)));
      const seen = () => { const ids = new Set(seenBatches().flatMap(receipt => receipt.messageIds)); return state.boundaryMessageIds.every(id => ids.has(id)); };
      const reacted = () => state.rumors.some(item => { const reaction = parseReaction(item); return reaction?.messageId === state.webHelloId && reaction.emoji === '👍'; });
      const controlsDeadline = Date.now() + 5000;
      while ((!seen() || !reacted()) && Date.now() < controlsDeadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert(seen(), 'Missing native seen receipt for a member of the 256-message boundary burst');
      assert.equal(seenBatches().length, 2, 'Native must split the 256-message read action into two receipts');
      assert(seenBatches().every(receipt => receipt.messageIds.length === 128), 'Every outgoing native receipt batch must have 128 targets');
      assert(reacted(), 'Missing native emoji reaction');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const invite = [...outgoing.values()].find(event => event.kind === 30078);
  assert(invite);
  state.entries = [...entries];
  await write('js-state.json', state);
  await write(phase === 'bootstrap' ? 'js-input-1.json' : phase === 'reply' ? 'js-input-2.json' : 'js-result.json', {
    authorization: state.authorization, invite, incoming: phase === 'bootstrap' ? [] : [...outgoing.values()],
    ...(phase === 'reply' ? {
      expected_text: 'Hello from web Market', mark_read: state.boundaryMessageIds,
      toggle_reactions: [{ message_id: webHello.id, emoji: '👍' }],
      expected_controls: [{ message_id: nativeHello.id, delivery: 'seen', reaction_emoji: '🇫🇮', reaction_count: 1 }],
    } : {}),
    send_text: phase === 'bootstrap' ? 'Hello from native Market' : 'Native reply received', received: state.received,
  });
  for (const event of outgoing.values()) assert(![7, 14, 15].includes(event.kind), 'Private content leaked as a public event');
  process.stdout.write(JSON.stringify({ phase, ownerIsSeparateDevice: owner !== device, signedOutgoing: outgoing.size, received: state.received.length, privateControls: state.rumors.filter(item => [7, 15].includes(item.kind)).length, boundarySeenTargets: phase === 'verify' ? state.boundaryMessageIds.length : 0 }) + '\n');
} finally { runtime.close(); ownerSecret.fill(0); deviceSecret.fill(0); }
