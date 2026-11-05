import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { DEFAULT_RELAYS } from '../src/public-relays.ts';
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

test('dispatch returns before connection or ACK; first matching ACK is observed despite a silent relay',async t=>{
  const fast=await relay(t,(socket,frame)=>{if(frame[0]==='EVENT')socket.send(JSON.stringify(['OK',frame[1].id,true,'']));});
  const silent=await relay(t,()=>{});
  const transport=createPrivateTransport(()=>[fast.url,silent.url]);t.after(()=>transport.close());
  let acknowledged=false;const signed=event('background ACK');
  const receipt=await transport.dispatch(signed,{timeoutMs:2000,onAccepted:()=>{acknowledged=true;}});
  assert.equal(receipt.remoteAccepted,false);assert.equal(receipt.pending,true);
  await waitFor(()=>acknowledged);
  assert.equal((await transport.publish(signed)).remoteAccepted,true);
  // Security-specific publication still resolves at first OK, not all relays.
  const accepted=await Promise.race([transport.publish(event('first ACK'),{timeoutMs:2000}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Waited for silent relay')),500))]);
  assert.equal(accepted.remoteAccepted,true);
});

test('more than three silent publications dispatch without a reply-gated concurrency slot',async t=>{
  const silent=await relay(t,()=>{}),transport=createPrivateTransport(()=>[silent.url]);t.after(()=>transport.close());
  let accepted=0;
  const receipts=await Promise.race([Promise.all(Array.from({length:5},(_,index)=>transport.dispatch(event(`silent ${index}`),{timeoutMs:3000,onAccepted:()=>accepted++}))),new Promise((_,reject)=>setTimeout(()=>reject(Error('Dispatch waited for a response')),200))]);
  assert(receipts.every(receipt=>receipt.pending&&!receipt.remoteAccepted));
  const end=Date.now()+2000;while(silent.frames.filter(item=>item.frame[0]==='EVENT').length<5){assert(Date.now()<end);await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(accepted,0);
});

test('queued publication callbacks do not consume inbox subscription slots',async t=>{
  const server=await relay(t,()=>{}),transport=createPrivateTransport(()=>[server.url]);t.after(()=>transport.close());
  await Promise.all(Array.from({length:130},(_,index)=>transport.dispatch(event(`queued slot ${index}`))));
  const subscription=transport.subscribe([{kinds:[1060],'#p':[owner]}],{onEvent(){}});
  await waitFor(()=>server.frames.some(item=>item.frame[0]==='REQ'));
  subscription.close();
});


test('a missing acknowledgement differs from an explicit rejection of the signed event', async t=>{
  const server=await relay(t, (socket, [kind, event])=>{
    if(kind==='EVENT' && event.content==='reject')socket.send(JSON.stringify(['OK',event.id,false,'blocked']));
  });
  const transport=createPrivateTransport(()=>[server.url]);t.after(()=>transport.close());
  const silent=await transport.publish(event('silent'),{timeoutMs:300});
  assert.equal(silent.remoteAccepted,false);
  assert.equal(silent.sentWithoutAck,true);
  const rejected=await transport.publish(event('reject'));
  assert.equal(rejected.remoteAccepted,false);
  assert.equal(rejected.sentWithoutAck,false);
});

// All selected public destinations are routed to one local test relay; no public posts.
test('default public reads and signed posting include Ditto without extending saved choices', async t => {
  assert(DEFAULT_RELAYS.includes('wss://relay.ditto.pub'));
  const listing = finalizeEvent({kind:30402,created_at:1,content:'Synthetic local route test',tags:[['d','route-test'],['title','Local route test'],['price','1','EUR']]},key);
  const server = await relay(t, (socket, frame) => {
    if(frame[0]==='REQ'){socket.send(JSON.stringify(['EVENT',frame[1],listing]));socket.send(JSON.stringify(['EOSE',frame[1]]));}
    if(frame[0]==='EVENT')socket.send(JSON.stringify(['OK',frame[1].id,true,'']));
  });
  for(const selected of [DEFAULT_RELAYS, DEFAULT_RELAYS.filter(url=>!url.includes('relay.ditto.pub')), ['wss://custom.example'], []]) {
    const routes=[];
    class LocalRoute extends WebSocket {constructor(url){routes.push(new URL(url).href);super(server.url);}}
    const transport=createPrivateTransport(()=>[...selected],{WebSocketImpl:LocalRoute});
    try {
      const expected=selected.map(url=>new URL(url).href).sort();
      if(!selected.length) {
        await assert.rejects(transport.query([{kinds:[30402]}]), /Choose between one and eight/);
        await assert.rejects(transport.publish(listing), /Choose between one and eight/);
        assert.deepEqual(routes,[]);
        continue;
      }
      const read=await transport.query([{kinds:[30402]}]);
      assert.deepEqual(routes.splice(0).sort(),expected);
      assert.equal(read.events.length,selected.length?1:0);
      const receipt=await transport.publish(listing);
      assert.equal(receipt.remoteAccepted,selected.length>0);
      assert.deepEqual(routes.splice(0).sort(),expected);
    } finally {transport.close();}
  }
});
