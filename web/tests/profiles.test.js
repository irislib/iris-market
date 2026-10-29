import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { SocialGraph } from 'nostr-social-graph'
import { DEFAULT_SOCIAL_GRAPH_ROOT, PROFILE_LIMITS, parseProfileEvent, parseFollowEvent, verifyProfileRecord, queryProfileRecords, socialConnection, excludeKnownFollowers, loadProfile, loadProfileFollowers, subscribeProfileMetadata, loadCurationContext, clearProfileCache, cacheProfileMetadata, readProfileMetadata } from '../src/profiles.ts'

const now = 1700000000
const secrets = Array.from({ length: 20 }, (_, i) => new Uint8Array(32).fill(i + 1))
const keys = secrets.map(getPublicKey)
const record = (author, kind, { content = '', follows = [], tags = follows.map(key => ['p', key]), at = now } = {}) => finalizeEvent({ kind, content, tags, created_at: at }, secrets[author])
const follows = (author, targets, at = now) => record(author, 3, { follows: targets, at })
const metadata = (author, data, at = now) => record(author, 0, { content: JSON.stringify(data), at })
const matches = (event, filter) => (!filter.kinds || filter.kinds.includes(event.kind)) && (!filter.authors || filter.authors.includes(event.pubkey)) && (!filter['#p'] || event.tags.some(tag => tag[0] === 'p' && filter['#p'].includes(tag[1])))
function scriptedSocket(respond) {
  const sockets = []
  return class Socket {
    static sockets = sockets
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.() } }) }
    send(value) {
      const frame = JSON.parse(value); this.sent.push(frame)
      if (frame[0] !== 'REQ') return
      const [_, id, ...filters] = frame
      queueMicrotask(() => {
        if (!this.onmessage) return
        const response = respond(filters, this)
        if (response === null) return
        for (const event of response || []) this.onmessage?.({ data: JSON.stringify(['EVENT', id, event]) })
        this.onmessage?.({ data: JSON.stringify(['EOSE', id]) })
      })
    }
    close() { this.readyState = 3; this.onclose?.() }
  }
}
const options = Socket => ({ relays: ['wss://profile.example'], WebSocketImpl: Socket, now: () => now, contextPubkey: keys[0] })
const closed = Socket => assert(Socket.sockets.every(socket => socket.readyState === 3 && socket.onmessage === null))

test('a locally signed profile hydrates shared names before relays reply and rejects forgery', () => {
  const relays = ['wss://local-profile.example'], event = metadata(0, {name:'Morgan'});
  cacheProfileMetadata(event,{relays,now});
  assert.equal(readProfileMetadata(keys[0],{relays}).name,'Morgan');
  assert.throws(()=>cacheProfileMetadata({...event,content:'{"name":"Forged"}'},{relays,now}),/Invalid/);
  assert.equal(readProfileMetadata(keys[0],{relays}).name,'Morgan');
});

test('profile metadata is authenticated, bounded and safe for text/HTTPS presentation', () => {
  const profile = parseProfileEvent(metadata(0, { display_name: '  Alice  ', about: '<img onerror=bad>', picture: 'javascript:bad', website: 'https://example.com', nip05: 'alice@example.com' }), { now })
  assert.equal(profile.name, 'Alice'); assert.equal(profile.about, '<img onerror=bad>')
  assert.equal(profile.pictureUrl, null); assert.equal(profile.website, 'https://example.com/')
  assert.equal(profile.nip05, 'alice@example.com')
  assert.equal('verified' in profile, false)
  const forged = metadata(0, { name: 'Alice' }); verifyProfileRecord(forged, { now }); forged.content = '{"name":"Forged"}'
  assert.throws(() => parseProfileEvent(forged, { now }), /Invalid/)
  assert.throws(() => parseProfileEvent(record(0, 0, { content: 'not-json' }), { now }), /metadata/)
  assert.throws(() => parseProfileEvent(metadata(0, {}, now + 301), { now }), /timestamp/)
})

test('follow parsing supports the default-root scale, deduplicates and rejects unsupported growth', () => {
  const targets = Array.from({ length: 345 }, (_, i) => i.toString(16).padStart(64, '0'))
  const list = parseFollowEvent(follows(0, [...targets, targets[0], keys[0]]), { now })
  assert.equal(list.follows.length, 345)
  assert.throws(() => parseFollowEvent(follows(0, Array.from({ length: PROFILE_LIMITS.follows + 1 }, (_, i) => i.toString(16).padStart(64, '0'))), { now }), /supported size/)
})

test('bounded relay reads select latest signed winners and deterministic equal-time revisions', async () => {
  const left = follows(0, [keys[1]]), right = follows(0, [keys[2]])
  const winner = left.id < right.id ? left : right
  for (const order of [[left, right], [right, left]]) {
    const wrongAuthor = follows(3, [keys[4]])
    const forged = { ...follows(0, [keys[5]], now + 1), content: 'forged' }
    const Socket = scriptedSocket(() => [wrongAuthor, forged, ...order])
    const result = await queryProfileRecords([{ kinds: [3], authors: [keys[0]], limit: 1 }], options(Socket))
    assert.equal(result.events.length, 1); assert.equal(result.events[0].id, winner.id)
    assert.equal(result.partial, true); assert.equal(result.completed, 1)
    assert(Socket.sockets[0].sent.every(frame => ['REQ', 'CLOSE'].includes(frame[0])))
    closed(Socket)
  }
})

test('aborts, unavailable transports and response caps remain explicit and close connections', async () => {
  const controller = new AbortController()
  const Socket = scriptedSocket(() => null)
  const result = queryProfileRecords([{ kinds: [3], authors: [keys[0]] }], { ...options(Socket), signal: controller.signal })
  controller.abort(); await assert.rejects(result, { name: 'AbortError' }); closed(Socket)
  await assert.rejects(queryProfileRecords([], { ...options(class { constructor() { throw Error('offline') } }) }), /Could not load/)
  const Limited = scriptedSocket(() => Array.from({ length: PROFILE_LIMITS.queryEvents + 1 }, () => follows(0, [keys[1]])))
  const bounded = await queryProfileRecords([{ kinds: [3], authors: [keys[0]] }], options(Limited))
  assert.equal(bounded.limited, true); assert.equal(bounded.partial, true); closed(Limited)
})

test('Iris relationship badges describe direct, friend and trusted paths without identity claims', async () => {
  const graph = new SocialGraph(keys[0])
  graph.handleEvent([follows(0, keys.slice(1, 13)), ...keys.slice(1, 13).map((_, i) => follows(i + 1, [keys[15]])), follows(1, [keys[15], keys[14]], now + 1)], true, Infinity)
  await graph.recalculateFollowDistances(1000, 100000, () => {})
  assert.equal(socialConnection(graph, keys[0], keys[1]).badge, 'following')
  const trusted = socialConnection(graph, keys[0], keys[15])
  assert.equal(trusted.badge, 'trusted'); assert.equal(trusted.distance, 2); assert.equal(trusted.knownFollowerCount, 12)
  assert.equal(socialConnection(graph, keys[0], keys[14]).badge, 'friend')
  assert.equal(socialConnection(graph, keys[0], keys[18]).distance, null)
  assert.equal(socialConnection(graph, keys[1], keys[15]).badge, null)
  assert.equal(socialConnection(null, keys[0], keys[1]).knownFollowerCount, 0)
})

test('default visitor context queries the established Sirius Business root, never an unsigned seed', async () => {
  clearProfileCache()
  const Socket = scriptedSocket(() => [])
  const context = await loadCurationContext({ ...options(Socket), contextPubkey: undefined })
  assert.equal(context.contextPubkey, DEFAULT_SOCIAL_GRAPH_ROOT)
  assert.equal(context.contextLabel, 'Sirius Business')
  assert.equal(context.coverage.rootLoaded, false)
  assert.equal(context.relationFor(keys[1]).distance, null)
  assert.deepEqual(Socket.sockets[0].sent[0][2].authors, [DEFAULT_SOCIAL_GRAPH_ROOT])
  closed(Socket)
})

test('Known is graph-only; explicit Followers checks bounded candidates against latest lists', async () => {
  clearProfileCache()
  const records = [follows(0, [keys[1], keys[2]]), follows(1, [keys[2]]), follows(2, [keys[0]]), follows(3, [keys[2]], now - 10), follows(3, [], now), follows(4, [keys[2]]), metadata(2, { name: 'Seller' }), metadata(1, { name: 'Friend' }), metadata(4, { name: 'Follower' })]
  const Socket = scriptedSocket(filters => records.filter(event => filters.some(filter => matches(event, filter))))
  const result = await loadProfile(keys[2], options(Socket))
  assert.equal(result.profile.name, 'Seller')
  assert.equal(result.mutualFollowing, true)
  assert.equal(result.following.total, 1)
  assert.equal(result.relation.distance, 1)
  assert.equal(result.followedByKnown[0].pubkey, keys[1])
  assert.equal(result.followers.loaded,false)
  assert(!Socket.sockets.flatMap(socket=>socket.sent.filter(frame=>frame[0]==='REQ').flatMap(frame=>frame.slice(2))).some(filter=>filter['#p']), 'opening the profile never requests inbound followers')
  const followers=await loadProfileFollowers(keys[2],options(Socket))
  assert.equal(followers.loaded,true)
  assert(followers.items.some(person => person.pubkey === keys[4]))
  assert(!followers.items.some(person => person.pubkey === keys[3]))
  assert.equal(result.followers.complete, false)
  assert.equal(result.coverage.partial, true)
  const requests = Socket.sockets.flatMap(socket => socket.sent.filter(frame => frame[0] === 'REQ').flatMap(frame => frame.slice(2)))
  assert(requests.some(filter => filter.kinds.includes(3) && !filter['#p'] && filter.authors?.includes(keys[3])))
  closed(Socket)
})

test('curation contexts reuse a bounded cached graph and skip per-listing queries', async () => {
  clearProfileCache()
  const records = [follows(0, [keys[1]]), follows(1, [keys[2]])]
  const Socket = scriptedSocket(filters => records.filter(event => filters.some(filter => matches(event, filter))))
  const first = await loadCurationContext(options(Socket)), reads = Socket.sockets.length
  const second = await loadCurationContext(options(Socket))
  assert.equal(first, second); assert.equal(reads, 2); assert.equal(Socket.sockets.length, reads)
  for (const key of keys) first.relationFor(key)
  assert.equal(Socket.sockets.length, reads)
  assert.equal(first.relationFor(keys[2]).distance, 2)
})

test('a newer unsupported signed follow list cannot resurrect older cached trust', async () => {
  clearProfileCache()
  let unsupported = false
  const large = follows(0, Array.from({ length: PROFILE_LIMITS.follows + 1 }, (_, i) => i.toString(16).padStart(64, '0')), now + 1)
  const Socket = scriptedSocket(filters => (unsupported ? [large] : [follows(0, [keys[1]])]).filter(event => filters.some(filter => matches(event, filter))))
  assert.equal((await loadCurationContext(options(Socket))).relationFor(keys[1]).distance, 1)
  unsupported = true
  const updated = await loadCurationContext({ ...options(Socket), now: () => now + 121 })
  assert.equal(updated.coverage.rootLoaded, false)
  assert.equal(updated.relationFor(keys[1]).distance, null)
})

function controlledSocket() {
  const sockets = []
  return class Socket {
    static sockets = sockets
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this) }
    send(value) { this.sent.push(JSON.parse(value)) }
    open() { this.readyState = 1; this.onopen?.() }
    event(event) { this.onmessage?.({ data: JSON.stringify(['EVENT', this.sent[0][1], event]) }) }
    eose() { this.onmessage?.({ data: JSON.stringify(['EOSE', this.sent[0][1]]) }) }
    close() { this.readyState = 3; this.onclose?.() }
  }
}

test('first successful relay starts a fixed grace that includes newer late replies', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const Socket = controlledSocket()
  const result = queryProfileRecords([{ kinds: [3], authors: [keys[0]] }], { ...options(Socket), relays: ['wss://one.example', 'wss://two.example', 'wss://stalled.example'] })
  let done = false; result.then(() => { done = true })
  Socket.sockets.forEach(socket => socket.open())
  const [first, second] = Socket.sockets
  first.event(follows(0, [keys[1]], now - 2)); first.eose()
  t.mock.timers.tick(400)
  const newer = follows(0, [keys[2]], now - 1)
  second.event(newer); second.eose()
  t.mock.timers.tick(99); await Promise.resolve(); assert.equal(done, false)
  t.mock.timers.tick(1)
  const response = await result
  assert.equal(response.events[0].id, newer.id)
  assert.equal(response.completed, 2); assert.equal(response.partial, true)
  closed(Socket)
  t.mock.timers.tick(6000) // Cleared deadline cannot affect the settled result.
  assert.equal((await result).events[0].id, newer.id)
})

test('without a successful relay the full deadline remains, and abort cancels the grace', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const Silent = controlledSocket()
  const result = queryProfileRecords([{ kinds: [3], authors: [keys[0]] }], options(Silent))
  const failed = assert.rejects(result, /timed out/)
  let done = false; result.then(() => { done = true }, () => { done = true })
  Silent.sockets[0].open()
  t.mock.timers.tick(5999); await Promise.resolve(); assert.equal(done, false)
  t.mock.timers.tick(1); await failed; closed(Silent)

  const controller = new AbortController(), Socket = controlledSocket()
  const duringGrace = queryProfileRecords([{ kinds: [3], authors: [keys[0]] }], { ...options(Socket), relays: ['wss://one.example', 'wss://stalled.example'], signal: controller.signal })
  Socket.sockets.forEach(socket => socket.open())
  Socket.sockets[0].event(follows(0, [keys[1]])); Socket.sockets[0].eose()
  t.mock.timers.tick(250); controller.abort()
  await assert.rejects(duringGrace, { name: 'AbortError' }); closed(Socket)
  t.mock.timers.tick(6000)
})


function discoveryBootstrap(edges) {
  return async ({ root }) => {
    const graph = new SocialGraph(root)
    for (const [author, followed] of edges) graph.addFollower(author, followed)
    const internal = graph.getInternalData()
    // Snapshot timestamps cannot veto a lower-timestamp, authenticated live list.
    for (const [author] of edges) internal.followListCreatedAt.set(internal.ids.id(author), now + 200)
    await graph.recalculateFollowDistances(1000, 100000, () => {})
    return { graph, provenance: { source: 'bundled-snapshot', verifiedEvents: false, stale: true } }
  }
}

test('snapshot discovery can rank without granting badges or entering the verified event cache', async () => {
  clearProfileCache()
  const Socket = scriptedSocket(() => [])
  const context = await loadCurationContext({ ...options(Socket), contextPubkey: DEFAULT_SOCIAL_GRAPH_ROOT,
    bootstrapLoader: discoveryBootstrap([[DEFAULT_SOCIAL_GRAPH_ROOT, keys[0]], [keys[0], keys[1]]]),
  })
  assert.equal(context.relationFor(keys[1]).distance, null)
  assert.equal(context.relationFor(keys[1]).badge, null)
  assert.equal(context.rankRelationFor(keys[1]).distance, 2)
  assert.equal(context.rankRelationFor(keys[1]).source, 'bundled-snapshot')
  assert.equal('badge' in context.rankRelationFor(keys[1]), false)
  assert.equal(context.coverage.bootstrap.verifiedEvents, false)
  assert.equal(context.coverage.rootLoaded, false)
  assert.equal(context.lists.size, 0)
})

test('signed live unfollows override snapshot timestamps and remove seeded ranking paths', async () => {
  clearProfileCache()
  const Socket = scriptedSocket(filters => [follows(0, [])].filter(event => filters.some(filter => matches(event, filter))))
  const context = await loadCurationContext({ ...options(Socket), contextPubkey: DEFAULT_SOCIAL_GRAPH_ROOT,
    bootstrapLoader: discoveryBootstrap([[DEFAULT_SOCIAL_GRAPH_ROOT, keys[0]], [keys[0], keys[1]]]),
  })
  assert.equal(context.rankRelationFor(keys[1]).distance, null)
  assert.equal(context.relationFor(keys[1]).badge, null)
  assert.equal(context.lists.get(keys[0]).follows.length, 0)
})

test('second-hop lookup favors snapshot paths to requested listing authors within the fixed bound', async () => {
  clearProfileCache()
  const direct = Array.from({ length: 40 }, (_, i) => (i + 1).toString(16).padStart(64, '0'))
  const contributor = direct[39], seller = keys[17]
  const Socket = scriptedSocket(() => [])
  const context = await loadCurationContext({ ...options(Socket), contextPubkey: DEFAULT_SOCIAL_GRAPH_ROOT, targetAuthors: [seller],
    bootstrapLoader: discoveryBootstrap([...direct.map(key => [DEFAULT_SOCIAL_GRAPH_ROOT, key]), [contributor, seller]]),
  })
  const request = Socket.sockets.flatMap(socket => socket.sent).find(frame => frame[0] === 'REQ' && frame[2].authors?.includes(contributor))
  assert(request)
  assert.equal(request[2].authors.length, PROFILE_LIMITS.secondHop)
  assert.equal(request[2].authors[0], contributor)
  assert.equal(context.coverage.secondHopRequested, PROFILE_LIMITS.secondHop)
})


test('shared worker metadata is cached and announced before history completes',async()=>{
  clearProfileCache();const relays=['wss://arrivals.example'],changes=[];let handlers,closed=0,settled=false;
  const stop=subscribeProfileMetadata(profile=>changes.push(profile),{relays});
  const runtime={subscribe(filters,next){handlers=next;return{close(){closed++}};},query(){assert.fail('Do not duplicate the live subscription with a finite query');}};
  const result=queryProfileRecords([{kinds:[0],authors:[keys[1]],limit:1}],{relays,runtime,now:()=>now,timeoutMs:1000}).then(value=>{settled=true;return value;});
  handlers.onEvent(metadata(1,{name:'Early name',picture:'https://example.com/avatar.png'}));
  assert.equal(readProfileMetadata(keys[1],{relays}).name,'Early name');assert.equal(changes.length,1);assert.equal(settled,false);
  handlers.onEvent({...metadata(1,{name:'Forged'},now+1),content:'forged'});assert.equal(changes.length,1);
  handlers.onEose({sources:[{id:'relay',complete:true}],complete:true,reason:'eose'});
  // A delayed cache admission after EOSE still updates the same view.
  handlers.onEvent(metadata(1,{name:'Later name'},now+1));assert.equal(changes.at(-1).name,'Later name');
  assert.equal((await result).events[0].content,'{"name":"Later name"}');assert.equal(closed,1);stop();
});

test('shared profile presentation restores signed name and avatar before any worker or relay starts',()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');let stored=null;
  Object.defineProperty(globalThis,'window',{value:{localStorage:{getItem:()=>stored,setItem:(_key,value)=>{stored=value}}},configurable:true});
  const relays=['wss://startup-heads.example'],event=metadata(0,{name:'Remembered',picture:'https://example.com/remembered.png'});
  try{
    clearProfileCache();cacheProfileMetadata(event,{relays,now});clearProfileCache();
    assert(stored);const restored=readProfileMetadata(keys[0],{relays});
    assert.equal(restored.name,'Remembered');assert.equal(restored.pictureUrl,'https://example.com/remembered.png');assert.equal(restored.eventId,event.id);
  }finally{clearProfileCache();if(previous)Object.defineProperty(globalThis,'window',previous);else delete globalThis.window;}
});

test('a newer signed unfollow supersedes known graph evidence without expanding follow-list queries',async()=>{
  clearProfileCache();
  const records=[follows(0,[keys[1]]),follows(1,[keys[2]])];
  const Socket=scriptedSocket(filters=>records.filter(event=>filters.some(filter=>matches(event,filter))));
  const first=await loadProfile(keys[2],options(Socket));assert.deepEqual(first.followedByKnown.map(person=>person.pubkey),[keys[1]]);
  records.push(follows(1,[],now+1));
  const inbound=await loadProfileFollowers(keys[2],options(Socket));assert.equal(inbound.items.length,0);assert(inbound.excludedKnownFollowers.includes(keys[1]));
  const reopened=await loadProfile(keys[2],options(Socket));assert.deepEqual(reopened.followedByKnown,[],'cached graph edges cannot revive newer observed unfollows');assert.equal(reopened.relation.badge,null);assert.equal(reopened.relation.knownFollowerCount,0);
  const queries=Socket.sockets.flatMap(socket=>socket.sent.filter(frame=>frame[0]==='REQ').flatMap(frame=>frame.slice(2)));
  assert.equal(queries.filter(filter=>filter['#p']).length,1,'only explicit Followers scans inbound lists');
  assert(queries.filter(filter=>filter.kinds.includes(3)&&filter.authors&&!filter.authors.includes(keys[0])&&!filter.authors.includes(keys[2])).every(filter=>filter.authors.length===1&&filter.authors[0]===keys[1]));
  closed(Socket);
});


test('explicit exclusions reduce second-hop trust but preserve root/direct indicators and unobserved paths',()=>{
  const relation={distance:2,badge:'trusted',knownFollowers:keys.slice(1,13),knownFollowerCount:12,description:'Previous evidence',partial:true};
  assert.equal(excludeKnownFollowers(relation,[keys[18]]),relation,'unrelated observations cannot alter known evidence');
  const partial=excludeKnownFollowers(relation,[keys[1],keys[2]]);assert.equal(partial.knownFollowerCount,10);assert.equal(partial.distance,2);assert.equal(partial.badge,'friend');assert.equal(partial.description,'Followed by 10 known people');
  const absent=excludeKnownFollowers(relation,keys.slice(1,13));assert.equal(absent.knownFollowerCount,0);assert.equal(absent.distance,null);assert.equal(absent.badge,null);
  for(const distance of [0,1]){const direct=excludeKnownFollowers({...relation,distance,badge:'following'},keys.slice(1,13));assert.equal(direct.distance,distance);assert.equal(direct.badge,'following');assert.equal(direct.description,'Previous evidence');}
  assert.equal(relation.knownFollowerCount,12,'the source graph projection is not mutated');
});
