// Run after npm run build. Exercise the emitted chunk, including its imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { SocialGraph } from 'nostr-social-graph';
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

test('the production chunk imports and decodes a fresh graph, rather than merely downloading it', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    requests++;
    assert.equal(new URL(url).searchParams.get('root'), root);
    return new Response(bytes, { headers: { 'x-graph-root': root } });
  });
  const loaded = await loadGraphBootstrap({ root });
  assert.equal(requests, 1);
  assert.equal(loaded.getRoot(), root);
  assert.equal(loaded.size().users, 2);
  assert.deepEqual([...loaded.getFollowedByUser(root)], [author]);
});

test('the production chunk rejects a response belonging to another graph', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes, { headers: { 'x-graph-root': author } }));
  await assert.rejects(loadGraphBootstrap({ root }), /root mismatch/);
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
