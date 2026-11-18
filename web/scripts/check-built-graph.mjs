// Run after npm run build. Exercise the emitted chunk, including its imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { SocialGraph } from 'nostr-social-graph';
import { createNamedGraphFixture } from 'nostr-social-graph/testing/namedGraph';
import { once } from 'node:events';
import { Negentropy, NegentropyStorageVector } from '../node_modules/nostr-social-graph/src/vendor/negentropy.js';
import { GRAPH_BOOTSTRAP } from '../src/graph-bootstrap.ts';

const chunks = new URL('../dist/chunks/', import.meta.url);
const names = (await readdir(chunks)).filter(name => /^publicGraphSync-.*\.js$/.test(name));
assert.equal(names.length, 1, 'Build Market before checking its graph chunk');
const { loadGraphBootstrap, syncGraphLists } = await import(new URL(names[0], chunks));
const root = GRAPH_BOOTSTRAP.root, author = '1'.repeat(64);
const graph = new SocialGraph(root);
graph.addFollower(root, author);
const bytes = await graph.toBinary();

async function namedSnapshot(t, contents = bytes) {
  const fixture = await createNamedGraphFixture(root, contents);
  const relay = new WebSocketServer({host: '127.0.0.1', port: 0});
  await once(relay, 'listening');
  t.after(async () => {
    for (const socket of relay.clients) socket.terminate();
    await new Promise(resolve => relay.close(resolve));
  });
  let names = 0;
  relay.on('connection', socket => socket.on('message', raw => {
    const [type, id, filter] = JSON.parse(String(raw));
    if (type === 'REQ' && filter.authors.includes(fixture.event.pubkey) &&
        filter.kinds.includes(30064) && filter['#d'].includes('social-graph')) {
      names++;
      socket.send(JSON.stringify(['EVENT', id, fixture.event]));
      socket.send(JSON.stringify(['EOSE', id]));
    }
  }));
  const blockReads = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const {origin, pathname} = new URL(url);
    assert.equal(origin, 'https://fixture.invalid');
    assert.match(pathname, /^\/[0-9a-f]{64}\.bin$/);
    const hash = pathname.slice(1, -4);
    blockReads.push(hash);
    const block = await fixture.readBlock(hash);
    assert(block);
    return new Response(block);
  });
  return {snapshot: {publisher: fixture.publisher, relays: ['ws://127.0.0.1:' + relay.address().port],
    blossomServers: ['https://fixture.invalid']}, blockReads, names: () => names};
}

test('the production reader rejects an authenticated 1,000-user public projection', async t => {
  const small = new SocialGraph(root);
  for (let i = 0; i < 999; i++) small.addFollower(root, i.toString(16).padStart(64, '0'));
  const fixture = await namedSnapshot(t, await small.toBinary());
  // The fixture signs with a test key, so apply the production coverage floor explicitly.
  await assert.rejects(loadGraphBootstrap({root, snapshot: fixture.snapshot, minUsers: 10_000}), /coverage/);
});

test('the production reader rejects trailing bytes under an otherwise valid directory signature', async t => {
  const fixture = await namedSnapshot(t, Uint8Array.from([...bytes, 0]));
  await assert.rejects(loadGraphBootstrap({root, snapshot: fixture.snapshot}), /trailing/i);
});

test('the production chunk reads the signed mobile graph from immutable blocks', async t => {
  const fixture = await namedSnapshot(t);
  const loaded = await loadGraphBootstrap({root, snapshot: fixture.snapshot});
  assert.equal(fixture.names(), 1);
  assert(fixture.blockReads.length >= 3);
  assert.equal(loaded.getRoot(), root);
  assert.equal(loaded.size().users, 2);
  assert.deepEqual([...loaded.getFollowedByUser(root)], [author]);
});

test('the production chunk rejects a scoring root absent from the signed manifest', async t => {
  const fixture = await namedSnapshot(t);
  await assert.rejects(loadGraphBootstrap({root: author, snapshot: fixture.snapshot}), /root|projection/i);
  assert.equal(fixture.names(), 1);
});

test('unsupported negentropy preserves the graph without broad follow/mute catch-up requests', async () => {
  const sent = [];
  class UnsupportedRelay {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(message) {
      const frame = JSON.parse(message); sent.push(frame);
      if (frame[0] === 'NEG-OPEN') queueMicrotask(() => this.onmessage?.({data:JSON.stringify(['NEG-ERR',frame[1],'unsupported'])}));
      if (frame[0] === 'REQ') queueMicrotask(() => this.onmessage?.({data:JSON.stringify(['EOSE',frame[1]])}));
    }
    close() { this.onclose?.(); }
  }
  await syncGraphLists({graph,relays:['wss://unsupported.example'],webSocket:UnsupportedRelay,timeoutMs:100,maxDurationMs:500});
  assert(sent.some(frame => frame[0] === 'NEG-OPEN'));
  assert(!sent.some(frame => frame[0] === 'REQ'), 'An unsupported relay must not trigger broad catch-up');
  assert.deepEqual([...graph.getFollowedByUser(root)], [author]);
});

test('the production chunk retrieves every revision when a relay caps each response at 100 events', async t => {
  const keys = Array.from({ length: 65 }, (_, i) => new Uint8Array(32).fill(i + 1));
  const authors = keys.map(getPublicKey);
  const events = keys.flatMap(key => [3, 10000].map(kind => finalizeEvent({
    kind, created_at: 1700000000, content: '', tags: [['p', root]],
  }, key)));
  const requests = [], clientFrames = [], connections = new Set();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    for (const socket of connections) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  let relayError;
  server.on('connection', socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    const sessions = new Map(); let pending = Promise.resolve();
    socket.on('message', raw => {
      pending = pending.then(async () => {
        const frame = JSON.parse(raw.toString()), id = frame[1];
        clientFrames.push(frame[0]);
        if (frame[0] === 'NEG-OPEN') {
          const storage = new NegentropyStorageVector();
          for (const event of events) if (frame[2].authors.includes(event.pubkey)) storage.insert(event.created_at, event.id);
          storage.seal();
          const session = new Negentropy(storage, 16384); sessions.set(id, session);
          const [reply] = await session.reconcile(frame[3]);
          if (reply) socket.send(JSON.stringify(['NEG-MSG', id, reply]));
        } else if (frame[0] === 'NEG-MSG') {
          const [reply] = await sessions.get(id).reconcile(frame[2]);
          if (reply) socket.send(JSON.stringify(['NEG-MSG', id, reply]));
        } else if (frame[0] === 'REQ') {
          requests.push(frame[2]);
          for (const event of events.filter(event => frame[2].ids.includes(event.id)).slice(0, 100)) socket.send(JSON.stringify(['EVENT', id, event]));
          socket.send(JSON.stringify(['EOSE', id]));
        }
      }).catch(error => { relayError = error; socket.close(); });
    });
  });
  const received = new SocialGraph(root);
  const result = await syncGraphLists({ graph: received, authors, relays: [`ws://127.0.0.1:${server.address().port}`], timeoutMs: 1000, maxDurationMs: 5000 });
  assert.equal(relayError, undefined);
  assert.equal(result.appliedEvents, events.length);
  assert.equal(result.completedAuthors, authors.length);
  assert.equal(result.failedRelays, 0);
  assert(requests.length >= 3);
  assert(requests.every(request => request.ids.length <= 64 && Object.keys(request).length === 1));
  assert(!clientFrames.includes('EVENT'), 'Reconciliation must never publish fixture events');
  for (const event of events) assert.equal(received.getListRevision(event.pubkey, event.kind).id, event.id);
});
