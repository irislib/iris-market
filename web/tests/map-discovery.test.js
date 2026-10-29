import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { MarketRelayClient } from '../src/market.ts'
import { createViewportDiscovery } from '../src/map/discovery.ts'

const now = 1800000000, secret = generateSecretKey()
const listing = (id, hash, extra = []) => finalizeEvent({ kind:30402, created_at:now-10, content:'A local listing', tags:[['d',id],['title',id],['g',hash],['t','Home'],...extra] },secret)
class Socket {
  static instances=[]
  constructor(){this.readyState=0;this.sent=[];Socket.instances.push(this)}
  send(raw){this.sent.push(JSON.parse(raw))}
  open(){this.readyState=1;this.onopen?.()}
  receive(frame){this.onmessage?.({data:JSON.stringify(frame)})}
  close(){this.readyState=3}
}
function client(options={}) {
  Socket.instances=[]
  return new MarketRelayClient({relays:['wss://map.example'],WebSocketImpl:Socket,now:()=>now,...options}).start()
}
test('map discovery streams signed results before EOSE, preserves inventory and ignores replaced areas',()=>{
  const app=client(),socket=Socket.instances[0]
  try {
    socket.open()
    const initial=socket.sent[0][1]
    socket.receive(['EVENT',initial,listing('recent','u6')])
    assert.equal(app.setGeohashes(['ud9','ud9w']),undefined)
    const query=socket.sent.at(-1),id=query[1]
    assert.deepEqual(query.slice(2).map(filter=>filter['#g']),[['ud9'],['ud9w']])
    assert(query.slice(2).every(filter=>filter.kinds[0]===30402))
    socket.receive(['EVENT',id,listing('map-only','ud9w')])
    socket.receive(['EVENT',id,listing('wrong-area','u6')])
    const forged={...listing('forged','ud9w'),content:'tampered'}
    socket.receive(['EVENT',id,forged])
    assert.deepEqual(app.listings().map(item=>item.identifier).sort(),['map-only','recent'])
    const requests=socket.sent.length;app.setGeohashes(['ud9w','ud9','ud9'])
    assert.equal(socket.sent.length,requests)
    app.setGeohashes(['u6'])
    assert(socket.sent.some(frame=>frame[0]==='CLOSE'&&frame[1]===id))
    socket.receive(['EVENT',id,listing('late-from-old-area','ud9w')])
    assert.equal(app.listings().length,2)
    const next=socket.sent.at(-1)[1];app.setGeohashes([])
    assert.deepEqual(socket.sent.at(-1),['CLOSE',next])
    assert.equal(app.listings().length,2)
    assert.equal(app.history.get('wss://map.example/').initialOldest,now-10)
  } finally {app.close()}
})
test('map requests respect author/tag filters, have bounded results and reconnect with the current area',()=>{
  const sample=listing('sample','ud9'),app=client({authors:[sample.pubkey],tags:['Home']}),socket=Socket.instances[0]
  try {
    app.setGeohashes(['u','ud','ud9','ud9w','ud9wr','ud9wr2'])
    socket.open();const query=socket.sent.at(-1)
    assert(query.slice(2).every(filter=>JSON.stringify(filter.authors)===JSON.stringify([sample.pubkey])&&filter['#t'][0]==='Home'))
    assert.equal(query.slice(2).reduce((n,filter)=>n+filter.limit,0),240)
    socket.readyState=3;app.refresh();const next=Socket.instances.at(-1);next.open()
    assert.deepEqual(next.sent.at(-1).slice(2),query.slice(2))
    for(const bad of [['u*'],['UD9'],Array(129).fill('u'),['u'.repeat(9)],null])assert.throws(()=>app.setGeohashes(bad),/map search/)
  } finally {app.close()}
})
test('empty following filters never widen into map discovery',()=>{
  const app=client({authors:[]})
  try {app.setGeohashes(['ud9']);assert.equal(Socket.instances.length,0)}finally{app.close()}
})
test('refresh restores a closed map subscription at the same viewport',()=>{
  const app=client(),socket=Socket.instances[0]
  try {
    socket.open();app.setGeohashes(['ud9']);const first=socket.sent.at(-1)
    socket.receive(['CLOSED',first[1],'temporary limit'])
    app.refresh();const next=socket.sent.at(-1)
    assert.equal(next[0],'REQ');assert.notEqual(next[1],first[1]);assert.deepEqual(next.slice(2),first.slice(2))
    socket.receive(['EVENT',next[1],listing('returned','ud9')])
    assert.equal(app.listings()[0].identifier,'returned')
  } finally {app.close()}
})
test('map discovery retains tombstones at the storage bound and exposes the limit',()=>{
  const app=client({maxRecords:1}),socket=Socket.instances[0]
  try {
    socket.open();socket.receive(['EVENT',socket.sent[0][1],listing('sold','u6',[['status','sold']])])
    app.setGeohashes(['ud9']);socket.receive(['EVENT',socket.sent.at(-1)[1],listing('new-map-result','ud9')])
    assert.equal(app.records.size,1);assert.equal(app.listings().length,0);assert.equal(app.pagination().limited,true)
  } finally {app.close()}
})
test('settled viewport changes debounce and deduplicate without waiting on query results',()=>{
  let callback,clears=0;const queries=[]
  const timers={setTimeout:fn=>{callback=fn;return 1},clearTimeout:()=>{callback=undefined;clears++}}
  const discovery=createViewportDiscovery(cells=>{queries.push(cells);return new Promise(()=>{})},{timers})
  discovery.update({west:24.8,east:25.1,south:60.1,north:60.3,zoom:10})
  assert.equal(callback,undefined)
  discovery.setActive(true);discovery.update({west:24.8,east:25.1,south:60.1,north:60.3,zoom:11})
  callback();assert.equal(queries.length,1);assert(queries[0].length>0)
  discovery.update({west:24.8,east:25.1,south:60.1,north:60.3,zoom:11});callback();assert.equal(queries.length,1)
  discovery.refresh();callback();assert.equal(queries.length,2)
  discovery.setActive(false);assert.deepEqual(queries.at(-1),[])
  assert.equal(callback,undefined);assert(clears>=4);discovery.dispose()
})
