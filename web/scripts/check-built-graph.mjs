// Run after npm run build. Exercise the emitted chunk, including its imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { SocialGraph } from 'nostr-social-graph';
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
