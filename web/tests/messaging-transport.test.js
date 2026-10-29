import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { createPrivateTransport } from '../src/messaging/transport.ts';

const key = generateSecretKey(), owner = getPublicKey(key);
const event = content => finalizeEvent({ kind: 0, content, tags: [], created_at: 1 }, key);
async function relay(t, receive) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  const sockets = new Set(), frames = [];
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('message', data => { const frame = JSON.parse(data.toString()); frames.push({ socket, frame }); receive(socket, frame); });
  });
  t.after(async () => { for (const socket of sockets) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  return { url: `ws://127.0.0.1:${server.address().port}`, sockets, frames };
}
const waitFor = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate()); };

test('real WebSocket query retains signed responses within the first-EOSE grace', async t => {
  const early = event('early'), late = event('late');
  const a = await relay(t, (socket, frame) => { if (frame[0] === 'REQ') { socket.send(JSON.stringify(['EVENT', frame[1], early])); socket.send(JSON.stringify(['EOSE', frame[1]])); } });
  const b = await relay(t, (socket, frame) => { if (frame[0] === 'REQ') setTimeout(() => { socket.send(JSON.stringify(['EVENT', frame[1], late])); socket.send(JSON.stringify(['EOSE', frame[1]])); }, 70); });
  const transport = createPrivateTransport(() => [a.url, b.url]); t.after(() => transport.close());
  const result = await transport.query([{ kinds: [0], authors: [owner] }]);
  assert.equal(result.complete, true); assert.deepEqual(new Set(result.events.map(item => item.id)), new Set([early.id, late.id]));
  await waitFor(() => a.sockets.size + b.sockets.size === 0);
});

test('publication uses a fresh send-only socket, requires exact ACK, and never answers AUTH', async t => {
  const server = await relay(t, (socket, frame) => {
    if (frame[0] === 'REQ') socket.send(JSON.stringify(['AUTH', 'challenge']));
    if (frame[0] === 'EVENT') { socket.send(JSON.stringify(['OK', 'different-id', true, ''])); setTimeout(() => socket.send(JSON.stringify(['OK', frame[1].id, true, ''])), 20); }
  });
  const transport = createPrivateTransport(() => [server.url]); t.after(() => transport.close());
  const sub = transport.subscribe([{ kinds: [1060], '#p': [owner] }], { onEvent() {} });
  await waitFor(() => server.frames.some(({ frame }) => frame[0] === 'REQ'));
  assert.equal((await transport.publish(event('publish'))).remoteAccepted, true);
  const reader = server.frames.find(({ frame }) => frame[0] === 'REQ').socket;
  const writer = server.frames.find(({ frame }) => frame[0] === 'EVENT').socket;
  assert.notEqual(reader, writer); assert.equal(server.frames.some(({ frame }) => frame[0] === 'AUTH'), false);
  assert.equal(server.frames.some(item => item.socket === writer && item.frame[0] === 'REQ'), false);
  sub.close(); await waitFor(() => server.sockets.size === 0);
});

test('query timeout remains partial without EOSE, while abort closes sockets promptly', async t => {
  const signed = event('partial');
  const server = await relay(t, (socket, frame) => { if (frame[0] === 'REQ') socket.send(JSON.stringify(['EVENT', frame[1], signed])); });
  const transport = createPrivateTransport(() => [server.url]); t.after(() => transport.close());
  const result = await transport.query([{ kinds: [0] }], { deadline: Date.now() + 80 });
  assert.equal(result.complete, false); assert.equal(result.events[0].id, signed.id);
  const controller = new AbortController();
  const pending = transport.query([{ kinds: [0] }], { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /abort/i);
  await waitFor(() => server.sockets.size === 0);
});

test('malformed or signature-mutated relay data never reaches private subscriptions', async t => {
  const signed = event('valid'), changed = { ...signed, content: 'forged' };
  const server = await relay(t, (socket, frame) => { if (frame[0] === 'REQ') {
    socket.send('not json'); socket.send(JSON.stringify(['EVENT', frame[1], changed]));
    socket.send(JSON.stringify(['EVENT', frame[1], signed])); socket.send(JSON.stringify(['EOSE', frame[1]]));
  } });
  const transport = createPrivateTransport(() => [server.url]); t.after(() => transport.close());
  assert.deepEqual((await transport.query([{ kinds: [0] }])).events.map(item => item.id), [signed.id]);
});
