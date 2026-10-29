import test from 'node:test'
import assert from 'node:assert/strict'
import {DecisionCache,decisionCacheKey,DECISION_CACHE_LIMIT,DECISION_CACHE_TTL} from '../src/feed-filter/decision-cache.ts'

const scope={model:'deberta',revision:'a'.repeat(40),device:'wasm',dtype:'q8',filterVersion:4,condition:'electronics under 100',content:'Used phone, €80',truncated:false,eventId:'b'.repeat(64)}
const key=value=>decisionCacheKey({...scope,content:value})
const yes={score:.9,show:true,truncated:false,milliseconds:3,inputTokens:20}
function memoryStore(initial=[]){
  const rows=new Map(initial.map(row=>[row.key,structuredClone(row)])),writes=[]
  return {rows,writes,async load(limit){return [...rows.values()].sort((a,b)=>b.accessedAt-a.accessedAt).slice(0,limit)},async write(records,removed,options){
    writes.push(structuredClone({records,removed,options}))
    for(const name of removed)rows.delete(name)
    for(const row of records)rows.set(row.key,structuredClone(row))
    for(const row of rows.values())if(options.now-row.createdAt>=options.ttl)rows.delete(row.key)
    const ordered=[...rows.values()].sort((a,b)=>b.accessedAt-a.accessedAt)
    for(const row of ordered.slice(options.limit))rows.delete(row.key)
  }}
}

test('opaque keys scope immutable model, filter/input version and signed listing revision',()=>{
  const original=decisionCacheKey(scope);assert.match(original,/^[a-f0-9]{64}$/)
  for(const [name,value] of Object.entries({model:'qwen35',revision:'c'.repeat(40),device:'webgpu',dtype:'q4',filterVersion:5,condition:'clothing',content:'Changed price',truncated:true,eventId:'d'.repeat(64)}))assert.notEqual(decisionCacheKey({...scope,[name]:value}),original,name)
  assert.equal(decisionCacheKey({...scope}),original);assert(!original.includes('electronics'))
})

test('memory LRU touches survive batched persistence and a fresh cache instance',async()=>{
  let now=1000;const store=memoryStore(),cache=new DecisionCache({store,limit:2,now:()=>now,delay:60000});await cache.ready
  cache.set(key('a'),yes);now++;cache.set(key('b'),yes);now++;assert(cache.get(key('a')));now++;cache.set(key('c'),yes)
  assert.equal(cache.size,2);assert.equal(cache.get(key('b')),undefined);assert.equal(store.writes.length,0)
  await cache.flush();assert.equal(store.writes.length,1);assert.equal(store.rows.size,2);assert(store.writes[0].removed.includes(key('b')))
  const restored=new DecisionCache({store,limit:2,now:()=>now,delay:60000});await restored.ready
  assert.deepEqual(restored.get(key('a')),yes);assert.deepEqual(restored.get(key('c')),yes);assert.equal(restored.get(key('b')),undefined);await restored.flush()
})

test('absolute expiry is not extended by reads and persisted payload contains no text or unknown fields',async()=>{
  let now=1000;const store=memoryStore(),cache=new DecisionCache({store,now:()=>now,delay:60000});await cache.ready
  cache.set(decisionCacheKey(scope),{...yes,query:scope.condition,listing:scope.content,error:'private diagnostic'});await cache.flush()
  const serialized=JSON.stringify([...store.rows.values()]);assert(!serialized.includes(scope.condition));assert(!serialized.includes(scope.content));assert(!serialized.includes('diagnostic'))
  now+=DECISION_CACHE_TTL-1;assert(cache.get(decisionCacheKey(scope)));now+=1;assert.equal(cache.get(decisionCacheKey(scope)),undefined);await cache.flush();assert.equal(store.rows.size,0)
})

test('slow or failed persistence never delays decisions and invalid results never enter cache',async()=>{
  const slow=new DecisionCache({store:{load:()=>new Promise(()=>{}),write:async()=>{}},delay:60000})
  assert.equal(slow.get(key('uncached')),undefined);assert.equal(slow.set(key('local'),yes),true);assert(slow.get(key('local')));await slow.flush()
  const failing=new DecisionCache({store:{load:async()=>{throw Error('denied')},write:async()=>{throw Error('quota')}},delay:60000});await failing.ready
  failing.set(key('a'),yes);assert(failing.get(key('a')));await failing.flush()
  for(const score of [NaN,Infinity,-.1,1.1,'0.5'])assert.equal(failing.set(key(String(score)),{score}),false)
  assert.equal(failing.set('not-a-hash',yes),false)
})

test('late hydration cannot overwrite newer local inference or exceed the fixed memory budget',async()=>{
  let hydrate;const store=memoryStore();store.load=()=>new Promise(resolve=>{hydrate=resolve})
  const cache=new DecisionCache({store,limit:2,now:()=>100,delay:60000});await Promise.resolve()
  cache.set(key('a'),{...yes,score:.2});cache.set(key('b'),yes)
  hydrate([{key:key('a'),decision:yes,createdAt:1,accessedAt:1},{key:key('c'),decision:yes,createdAt:2,accessedAt:2}]);await cache.ready
  assert.equal(cache.get(key('a')).score,.2);assert.equal(cache.size,2);assert.equal(cache.get(key('c')),undefined);await cache.flush()
  const bounded=new DecisionCache({store:null,limit:99999});for(let index=0;index<DECISION_CACHE_LIMIT+5;index++)bounded.set(key(String(index)),yes)
  assert.equal(bounded.size,DECISION_CACHE_LIMIT);assert.equal(bounded.get(key('0')),undefined)
})

test('pending writes are serialized and new decisions are retained for the next batch',async()=>{
  const writes=[];let finish;const store={load:async()=>[],write:records=>{writes.push(records);return new Promise(resolve=>{finish=resolve})}}
  const cache=new DecisionCache({store,delay:60000});await cache.ready;cache.set(key('a'),yes);const first=cache.flush();await Promise.resolve()
  cache.set(key('b'),yes);assert.equal(cache.flush(),first);assert.equal(writes.length,1);finish();await first
  const second=cache.flush();await Promise.resolve();assert.equal(writes.length,2);assert.deepEqual(writes[1].map(row=>row.key),[key('b')]);finish();await second
})
