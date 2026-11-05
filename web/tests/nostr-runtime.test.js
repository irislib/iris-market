import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { createPublicRuntime, publicIndexSource, rejectPublicSigning, publicWorkerConfig, getPublicRuntime, closePublicRuntimes } from '../src/nostr-runtime.ts';
import { SocialGraph } from 'nostr-social-graph';
import { GRAPH_BOOTSTRAP } from '../src/graph-bootstrap.ts';
import { DEFAULT_RELAYS, validateRelays } from '../src/market.ts';

const key=generateSecretKey();
const event=(kind=0,content='{}')=>finalizeEvent({kind,content,tags:[],created_at:Math.floor(Date.now()/1000)},key);
const completion={complete:false,reason:'unavailable',sources:[]};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const until=async check=>{for(let i=0;i<80;i++){if(check())return;await tick()}assert.fail('condition not reached')};
function fixture(options={}) {
  const clients=[];
  const createClient=async failed=>{
    const subscriptions=[];
    const client={subscriptions,failed,closed:0,
      init:options.init??(async()=>{}),
      queryEvents:options.query??(async()=>({...completion,events:[]})),
      subscribeEvents(filters,handlers){const entry={filters,handlers,closed:false};subscriptions.push(entry);return{close(){entry.closed=true}}},
      publishEvent:async()=>({accepted:false,remoteAccepted:false,queued:true,sources:[]}),
      ingestEvents:async events=>{client.imported=events},
      setNostrSource:async source=>{client.source=source},
      close:async()=>{client.closed++},
    };clients.push(client);return client;
  };
  return {clients,runtime:createPublicRuntime({relays:['wss://example.test'],createClient,retryMs:1})};
}

test('anonymous worker configuration satisfies the shared graph initialization without profile keys',()=>{
  const config=publicWorkerConfig(['wss://example.test']);
  assert.equal(new SocialGraph(config.pubkey).getRoot(),GRAPH_BOOTSTRAP.root);
  assert.equal(config.pubkey,GRAPH_BOOTSTRAP.root);assert.equal('nsec' in config,false);
  assert.deepEqual(config.reconciliation,{lookbackSeconds:7*86400});
});

test('fixed graph bootstrap is explicit and restricted to the shipped relay set',()=>{
  for(const relays of [DEFAULT_RELAYS,validateRelays(DEFAULT_RELAYS).reverse()]) {
    const config=publicWorkerConfig(relays);
    assert.equal(config.graphBootstrap,true);
    assert.deepEqual(config.relays,relays);
  }
  for(const relays of [[],['wss://custom.example'],DEFAULT_RELAYS.slice(1),[...DEFAULT_RELAYS,'wss://custom.example']]) {
    const config=publicWorkerConfig(relays);
    assert.equal(config.graphBootstrap,false);
    assert.deepEqual(config.relays,relays);
    assert.notEqual(config.graphReconciliation,false,'Configured-relay reconciliation stays enabled');
  }
});

test('changing relay settings terminates initializing workers and creates a fresh policy',async t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'Worker'),workers=[];
  class PendingWorker extends EventTarget {
    constructor(){super();this.messages=[];this.terminated=false;workers.push(this);}
    postMessage(message){this.messages.push(message);}
    dispatchEvent(event){if(event.type==='error')this.onerror?.(event);return super.dispatchEvent(event);}
    terminate(){this.terminated=true;}
  }
  Object.defineProperty(globalThis,'Worker',{value:PendingWorker,writable:true,configurable:true});
  t.after(()=>{closePublicRuntimes();if(previous)Object.defineProperty(globalThis,'Worker',previous);else delete globalThis.Worker;});
  closePublicRuntimes();
  const first=getPublicRuntime(DEFAULT_RELAYS);
  await until(()=>workers[0]?.messages.some(message=>message.type==='init'));
  assert.equal(workers[0].messages[0].config.graphBootstrap,true);
  closePublicRuntimes();
  assert.equal(workers[0].terminated,true);
  await assert.rejects(first.query([{kinds:[3]}]),{name:'AbortError'});
  const next=getPublicRuntime(['wss://custom.example']);
  assert.notEqual(next,first);
  await until(()=>workers[1]?.messages.some(message=>message.type==='init'));
  assert.equal(workers[1].messages[0].config.graphBootstrap,false);
  closePublicRuntimes();
  assert.equal(workers[1].terminated,true);
  assert.notEqual(getPublicRuntime(DEFAULT_RELAYS),first,'Returning to defaults cannot reuse a closed worker');
});

test('public worker reserves a small cache budget before exposing network queries',async()=>{
  const {createPublicWorkerClient}=await import('../src/nostr-runtime.ts');
  const messages=[];
  class ReadyWorker extends EventTarget {
    postMessage(message){
      messages.push(message);
      queueMicrotask(()=>this.onmessage?.(new MessageEvent('message',{data:message.type==='init'?{type:'ready'}:{type:'void',id:message.id}})));
    }
    terminate(){}
  }
  const client=await createPublicWorkerClient([],()=>{}, {WorkerImpl:ReadyWorker,workerURL:'test.worker.js'});
  await client.init();
  assert.deepEqual(messages.map(message=>message.type),['init','setStorageMaxBytes']);
  assert.equal(messages[1].maxBytes,128*1024*1024);
});

test('a ready worker flushes through close before termination',async()=>{
  const {createPublicWorkerClient}=await import('../src/nostr-runtime.ts');
  const calls=[];let worker,finish;
  class SavingWorker extends EventTarget {
    constructor(){super();worker=this;}
    dispatchEvent(event){const result=super.dispatchEvent(event);this[`on${event.type}`]?.(event);return result;}
    postMessage(message){
      calls.push(message.type);
      if(message.type==='close'){finish=()=>this.dispatchEvent(new MessageEvent('message',{data:{type:'void',id:message.id}}));return;}
      queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:message.type==='init'?{type:'ready'}:{type:'void',id:message.id}})));
    }
    terminate(){calls.push('terminate');}
  }
  const client=await createPublicWorkerClient(DEFAULT_RELAYS,()=>{}, {WorkerImpl:SavingWorker,workerURL:'test.worker.js'});
  await client.init();const closing=client.close();await until(()=>!!finish);
  assert(calls.includes('close'));assert(!calls.includes('terminate'));
  finish();await closing;assert(calls.indexOf('close')<calls.indexOf('terminate'));
});

test('a replacement worker waits for the previous graph flush without blocking settings',async t=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'Worker'),workers=[];
  class SavingWorker extends EventTarget {
    constructor(){super();this.messages=[];workers.push(this);}
    dispatchEvent(event){const result=super.dispatchEvent(event);this[`on${event.type}`]?.(event);return result;}
    postMessage(message){
      this.messages.push(message);
      const respond=()=>this.dispatchEvent(new MessageEvent('message',{data:message.type==='init'?{type:'ready'}:{type:'void',id:message.id}}));
      if(message.type==='close'&&this===workers[0])this.finish=respond;else queueMicrotask(respond);
    }
    terminate(){this.terminated=true;}
  }
  await closePublicRuntimes();
  Object.defineProperty(globalThis,'Worker',{value:SavingWorker,writable:true,configurable:true});
  t.after(async()=>{workers[0]?.finish?.();await closePublicRuntimes();if(previous)Object.defineProperty(globalThis,'Worker',previous);else delete globalThis.Worker;});
  getPublicRuntime(DEFAULT_RELAYS);
  await until(()=>workers[0]?.messages.some(message=>message.type==='setStorageMaxBytes'));
  const closing=closePublicRuntimes(),replacement=getPublicRuntime(['wss://custom.example']);
  assert(replacement,'Settings can select the replacement synchronously');
  await until(()=>!!workers[0].finish);await tick();assert.equal(workers.length,1);
  workers[0].finish();await closing;
  await until(()=>workers[1]?.messages.some(message=>message.type==='init'));
  assert.equal(workers[0].terminated,true);
  assert.equal(workers[1].messages[0].config.graphBootstrap,false);
});

test('public cache imports verify records and cannot publish or accept private events',async()=>{
  const {runtime,clients}=fixture(),record=event();
  await runtime.ingest([record]);assert.deepEqual(clients[0].imported,[record]);
  await assert.rejects(runtime.ingest([event(1059)]),/Only signed public/);
  await assert.rejects(runtime.ingest([{...record,content:'forged'}]),/Only signed public/);
  await assert.rejects(runtime.ingest(Array(129).fill(record)),/too large/);
  runtime.close();
});

test('a public subscription delivers verified records without waiting for EOSE',async()=>{
  const {runtime,clients}=fixture(),seen=[];
  const subscription=runtime.subscribe([{kinds:[0]}],{onEvent:value=>seen.push(value)});
  await until(()=>clients[0]?.subscriptions.length);
  const handlers=clients[0].subscriptions[0].handlers,record=event();
  handlers.onEvent(record,{source:'relay',cached:false});
  handlers.onEvent({...record,content:'tampered'},{source:'relay',cached:false});
  handlers.onEvent(event(1059),{source:'relay',cached:false});
  assert.deepEqual(seen.map(value=>value.id),[record.id]);
  subscription.close();handlers.onEvent(event(0,'{"name":"Later"}'),{source:'relay',cached:false});
  assert.equal(seen.length,1);runtime.close();
});

test('offline cached queries keep honest completion and reject private scopes',async()=>{
  const record=event(),{runtime}=fixture({query:async()=>({...completion,events:[record]})});
  assert.equal((await runtime.query([{kinds:[0]}],{cache:'cache-only'})).events[0].id,record.id);
  assert.equal((await runtime.query([{kinds:[0]}])).complete,false);
  await assert.rejects(runtime.query([{kinds:[1059]}]),/Only public/);
  assert.throws(()=>runtime.subscribe([{}],{onEvent(){}}),/Only public/);
  await assert.rejects(runtime.publish(event(1060)),/Invalid public/);
  runtime.close();
});

test('referenced public shipping records are allowed without admitting private order messages',async()=>{
  const {runtime}=fixture();
  for(const kind of [30405,30406])await runtime.query([{kinds:[kind],authors:[event().pubkey],'#d':['shipping']}]);
  for(const kind of [14,16,17,1059,1060])await assert.rejects(runtime.query([{kinds:[kind]}]),/Only public/);
  runtime.close();
});

test('cancelling during worker startup returns immediately and never starts the query',async()=>{
  let start,queries=0;
  const {runtime}=fixture({init:()=>new Promise(resolve=>start=resolve),query:async()=>{queries++;return{...completion,events:[]}}});
  const controller=new AbortController(),pending=runtime.query([{kinds:[3]}],{signal:controller.signal});
  await until(()=>!!start);controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(queries,0);start();await tick();runtime.close();
});

test('closing cancels active queries and releases live subscriptions',async()=>{
  let signal;
  const {runtime,clients}=fixture({query:async(_filters,options)=>new Promise((_,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true})})});
  runtime.subscribe([{kinds:[3]}],{onEvent(){}});
  const pending=runtime.query([{kinds:[3]}]);await until(()=>!!signal);runtime.close();
  await assert.rejects(pending,{name:'AbortError'});assert.ok(signal.aborted);assert.ok(clients[0].subscriptions[0].closed);
});

test('worker crash reconnects subscriptions once and rejects late events from the old worker',async()=>{
  const {runtime,clients}=fixture(),seen=[];
  runtime.subscribe([{kinds:[0]}],{onEvent:value=>seen.push(value)});
  await until(()=>clients[0]?.subscriptions.length);
  const old=clients[0].subscriptions[0];clients[0].failed();
  await until(()=>clients[1]?.subscriptions.length);
  old.handlers.onEvent(event(),{source:'old',cached:false});
  const fresh=event(0,'{"name":"Restored"}');clients[1].subscriptions[0].handlers.onEvent(fresh,{source:'new',cached:false});
  assert.equal(clients[1].subscriptions.length,1);assert.deepEqual(seen.map(item=>item.id),[fresh.id]);assert.equal(clients[0].closed,1);runtime.close();
});

test('public publish preserves queued receipt and public peer attachment is bounded',async()=>{
  const {runtime,clients}=fixture();
  assert.deepEqual(await runtime.publish(event()),{accepted:false,remoteAccepted:false,queued:true,sources:[]});
  const source={id:'public-peers'};await runtime.setSources([source]);assert.equal(clients[0].source.id,source.id);
  await assert.rejects(runtime.setSources([source,source]),/one public/);runtime.close();
});

test('public worker signing requests cannot reach extension callbacks',()=>{
  for(const [type,reply] of [['signEvent','signed'],['nip44Encrypt','encrypted'],['nip44Decrypt','decrypted']]){
    let stopped=false;const messages=[];
    assert.equal(rejectPublicSigning({data:{type,id:'challenge'},stopImmediatePropagation(){stopped=true}},{postMessage:value=>messages.push(value)}),true);
    assert.ok(stopped);assert.equal(messages[0].type,reply);assert.equal(messages[0].id,'challenge');assert.match(messages[0].error,/does not use/);
  }
  assert.equal(rejectPublicSigning({data:{type:'event'}},{postMessage(){assert.fail('must not send')}}),false);
});


test('public index source filters signed private and unrelated records before worker storage',async()=>{
  const own=event(),privateEvent=event(1059),other=event(3),wrap=event=>({event,source:{kind:'local-index',id:'index'},priority:300});
  let listener;
  const source=publicIndexSource({id:'index',query:async()=>({events:[wrap(own),wrap(privateEvent),wrap(other)],complete:true}),subscribe:(_filters,callback)=>{listener=callback;return{close(){}}}});
  const result=await source.query([{kinds:[0]}]);
  assert.deepEqual(result.events.map(value=>value.event.id),[own.id]);assert.equal(result.complete,false);
  const seen=[];source.subscribe([{kinds:[0]}],item=>seen.push(item.event.id));listener(wrap(privateEvent));listener(wrap(other));listener(wrap(own));
  assert.deepEqual(seen,[own.id]);await assert.rejects(source.query([{kinds:[1059]}]),/Only public/);
});

test('actual relay client startup crashes stop at the retry bound and cleanup never respawns a worker',async()=>{
  const {createPublicWorkerClient}=await import('../src/nostr-runtime.ts');
  const previousErrorEvent=globalThis.ErrorEvent;
  class WorkerError extends Event{constructor(type,{message}={}){super(type);this.message=message;}}
  globalThis.ErrorEvent=WorkerError;
  try{
    for(const failure of ['module','init-message']){
      const workers=[];
      class BrokenWorker extends EventTarget{
        constructor(){super();this.terminated=0;workers.push(this);}
        dispatchEvent(event){const result=super.dispatchEvent(event);this[`on${event.type}`]?.(event);return result;}
        postMessage(message){if(message.type==='init')queueMicrotask(()=>{if(!this.terminated){if(failure==='module')this.dispatchEvent(new WorkerError('error',{message:'Module import failed'}));else this.dispatchEvent(new MessageEvent('message',{data:{type:'error',id:message.id,error:'Invalid worker configuration'}}));}});}
        terminate(){this.terminated++;}
      }
      const runtime=createPublicRuntime({relays:[],retryMs:1,createClient:failed=>createPublicWorkerClient([],failed,{WorkerImpl:BrokenWorker,workerURL:'test.worker.js'})});
      await assert.rejects(runtime.query([{kinds:[0]}]),/Module import failed|Invalid worker configuration/);
      await until(()=>workers.length===4&&workers.every(worker=>worker.terminated));
      await new Promise(resolve=>setTimeout(resolve,30));assert.equal(workers.length,4);
      runtime.close();await tick();assert.equal(workers.length,4);
    }
  }finally{if(previousErrorEvent===undefined)delete globalThis.ErrorEvent;else globalThis.ErrorEvent=previousErrorEvent;}
});

test('closing the actual relay client during pending initialization cancels promptly and never queries',async()=>{
  const {createPublicWorkerClient}=await import('../src/nostr-runtime.ts');
  const previousErrorEvent=globalThis.ErrorEvent;
  class WorkerError extends Event{constructor(type,{message}={}){super(type);this.message=message;}}
  globalThis.ErrorEvent=WorkerError;
  const workers=[];
  class PendingWorker extends EventTarget{
    constructor(){super();this.messages=[];this.terminated=0;workers.push(this);}
    dispatchEvent(event){const result=super.dispatchEvent(event);this[`on${event.type}`]?.(event);return result;}
    postMessage(message){this.messages.push(message);}
    terminate(){this.terminated++;}
  }
  const runtime=createPublicRuntime({relays:[],retryMs:1,createClient:failed=>createPublicWorkerClient([],failed,{WorkerImpl:PendingWorker,workerURL:'test.worker.js'})});
  try{
    const result=runtime.query([{kinds:[0]}]);await until(()=>workers.length===1);runtime.close();
    await assert.rejects(result,{name:'AbortError'});await tick();
    assert(workers[0].terminated);assert.deepEqual(workers[0].messages.map(message=>message.type),['init']);assert.equal(workers.length,1);
  }finally{runtime.close();if(previousErrorEvent===undefined)delete globalThis.ErrorEvent;else globalThis.ErrorEvent=previousErrorEvent;}
});

// Product recommendations are public; private payment/chat payloads remain excluded.
test('public runtime admits signed product recommendations',async()=>{
 const recommendation=event(31555,'Useful item'),{runtime}=fixture({query:async()=>({...completion,events:[recommendation]})});
 try{const result=await runtime.query([{kinds:[31555],'#a':['30402:'+recommendation.pubkey+':item']}]);assert.equal(result.events[0].id,recommendation.id);}finally{runtime.close();}
});
