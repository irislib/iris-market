import { matchFilters, verifyEvent, type Event, type Filter, type VerifiedEvent } from 'nostr-tools';
import type { RuntimeCompletion, RuntimeEventInfo, RuntimePublishResult, RuntimeQueryOptions, RuntimeQueryResult, RuntimeSource, RuntimeSubscription, RuntimeSubscriptionHandlers } from 'nostr-pubsub';
import { assetUrl } from './asset-url.ts';
import { createPublicIndex } from './public-index.ts';
import { GRAPH_BOOTSTRAP } from './graph-bootstrap.ts';

/** This runtime contains PUBLIC market data only. NDR uses its own private transport. */
const PUBLIC_KINDS = new Set([0, 3, 5, 7368, 30402, 30405, 30406, 31555, 30064, 30078]);
export interface PublicEventRuntime {
  query(filters: Filter[], options?: RuntimeQueryOptions): Promise<RuntimeQueryResult>;
  subscribe(filters: Filter[], handlers: RuntimeSubscriptionHandlers): RuntimeSubscription;
  publish(event: Event): Promise<RuntimePublishResult>;
  ingest(events: Event[]): Promise<void>;
  setSources(sources: RuntimeSource[]): Promise<void>;
  close(): void;
}
export interface PublicWorkerClient {
  init(): Promise<void>;
  queryEvents(filters: Filter[], options?: RuntimeQueryOptions): Promise<RuntimeQueryResult>;
  subscribeEvents(filters: Filter[], handlers: RuntimeSubscriptionHandlers): RuntimeSubscription;
  publishEvent(event: Event): Promise<RuntimePublishResult>;
  ingestEvents(events: Event[]): Promise<void>;
  setNostrSource(source: RuntimeSource | null): Promise<void>;
  close(): Promise<void>;
}
interface RuntimeOptions {
  relays: readonly string[];
  createClient?: (failed: (error?:Error) => void) => Promise<PublicWorkerClient>;
  retryMs?: number;
}
const cancelled = () => new DOMException('Public request cancelled', 'AbortError');

/** Shared worker initializes a graph even for anonymous reads; its root must be a public key. */
export function publicWorkerConfig(relays:readonly string[]) {
  return {relays:[...relays],blossomServers:[],pubkey:GRAPH_BOOTSTRAP.root,storeName:'iris-market-public-events-v1',reconciliation:{lookbackSeconds:7*86400}};
}

function publicFilters(filters: Filter[]): Filter[] {
  if (!Array.isArray(filters) || !filters.length || filters.length > 64 ||
      filters.some(filter => !filter.kinds?.length || filter.kinds.some(kind => !PUBLIC_KINDS.has(kind)))) {
    throw new Error('Only public marketplace records belong in this connection.');
  }
  if (JSON.stringify(filters).length > 64 * 1024) throw new Error('Public search is too large.');
  return structuredClone(filters);
}

function publicEvent(input: Event): VerifiedEvent | null {
  if (!PUBLIC_KINDS.has(input?.kind)) return null;
  try {
    const event = {id:input.id,pubkey:input.pubkey,created_at:input.created_at,kind:input.kind,
      content:input.content,tags:input.tags.map(tag=>[...tag]),sig:input.sig};
    return JSON.stringify(event).length <= 1024 * 1024 && verifyEvent(event) ? event : null;
  } catch { return null; }
}

/** A provider cannot smuggle unrelated/private records into the public worker cache. */
export function publicIndexSource(source: RuntimeSource): RuntimeSource {
  if(!source || typeof source.id!=='string' || !source.id || source.id.length>128) throw new Error('Invalid public peer provider.');
  const accept=(record,filters)=>{const event=publicEvent(record?.event);return event&&matchFilters(filters,event)?{...record,event}:null;};
  return {
    id:source.id,publishAcceptance:source.publishAcceptance,
    ...(source.query?{async query(filters,options){
      const selected=publicFilters(filters),report=await source.query(selected,options);
      const events=report.events.map(record=>accept(record,selected)).filter(Boolean);
      return {...report,events,complete:report.complete!==false&&events.length===report.events.length};
    }}:{}),
    ...(source.subscribe?{subscribe(filters,handler){
      const selected=publicFilters(filters);return source.subscribe(selected,record=>{const valid=accept(record,selected);if(valid)handler(valid);});
    }}:{}),
    ...(source.publish?{async publish(input,origin){const event=publicEvent(input);if(!event)throw new Error('Invalid public event.');return source.publish(event,origin);}}:{}),
  };
}

/** A public relay challenge must never invoke a user's extension or expose their identity. */
export function rejectPublicSigning(event: MessageEvent, worker: Pick<Worker, 'postMessage'>): boolean {
  const replies = {signEvent:'signed',nip44Encrypt:'encrypted',nip44Decrypt:'decrypted'};
  const type = replies[event.data?.type];
  if (!type) return false;
  event.stopImmediatePropagation();
  worker.postMessage({type,id:event.data.id,error:'Public browsing does not use a profile signer.'});
  return true;
}

export async function createPublicWorkerClient(relays: readonly string[], failed: (error?:Error) => void, {WorkerImpl=globalThis.Worker,workerURL=assetUrl('nostr.worker.js')}={}): Promise<PublicWorkerClient> {
  const { RelayWorkerClient } = await import('@hashtree/worker/relay-client');
  const workers=new Set<Worker>();let disposed=false,closing:Promise<void>|undefined;
  // The shared client accepts a Worker constructor. Install the public-only
  // signing boundary before its onmessage handler, without modifying the library.
  const PublicWorker = class {
    constructor() {
      if(disposed)throw cancelled();
      const worker = new WorkerImpl(workerURL, {type:'module'});workers.add(worker);let ready=false;
      worker.addEventListener('message', event => {
        if(rejectPublicSigning(event, worker))return;
        if(event.data?.type==='ready')ready=true;
        // The pinned client only matches ordinary request errors. An init
        // failure is otherwise left pending until its 30-second timeout.
        if(!disposed&&!ready&&event.data?.type==='error')failed(new Error(String(event.data.error||'Public worker could not start.')));
      });
      worker.addEventListener('error', event=>{if(!disposed)failed(new Error(event.message||'Public worker stopped.'));});
      return worker;
    }
  } as unknown as new () => Worker;
  const client=new RelayWorkerClient(PublicWorker, publicWorkerConfig(relays));
  return {
    async init(){
      await client.init();
      // Keep public browsing history from consuming space needed for private
      // orders. The worker also reclaims obsolete event-index blocks.
      await client.setStorageMaxBytes(128*1024*1024);
    },queryEvents:(filters,options)=>client.queryEvents(filters,options),
    subscribeEvents:(filters,handlers)=>client.subscribeEvents(filters,handlers),publishEvent:event=>client.publishEvent(event),
    ingestEvents:events=>client.ingestEvents(events),
    setNostrSource:source=>client.setNostrSource(source),
    close(){
      if(closing)return closing;
      disposed=true;
      for(const worker of workers){
        // Cancel the client's pending promises before close(), which otherwise
        // calls init() again after a startup crash. The constructor guard above
        // prevents that cleanup request from creating a replacement worker.
        worker.dispatchEvent(new ErrorEvent('error',{message:'Public worker closed.'}));worker.terminate();
      }
      workers.clear();closing=client.close();return closing;
    },
  };
}

/** One shared worker, with bounded crash recovery. Relay reconnects belong to pubsub. */
export function createPublicRuntime({relays,createClient,retryMs=500}: RuntimeOptions): PublicEventRuntime {
  let client: PublicWorkerClient | null = null, initializing:PublicWorkerClient|null=null, starting: Promise<PublicWorkerClient> | null = null;
  let closed = false, generation = 0, retries = 0, restart: ReturnType<typeof setTimeout> | null = null;
  let source: RuntimeSource | null = null;
  const subscriptions = new Set<{filters:Filter[];handlers:RuntimeSubscriptionHandlers;handle?:RuntimeSubscription}>();
  const queries = new Set<AbortController>();

  function bind(entry: (typeof subscriptions extends Set<infer T> ? T : never), current: PublicWorkerClient) {
    entry.handle?.close();
    const version=generation;
    const active=()=>version===generation && client===current && subscriptions.has(entry);
    entry.handle = current.subscribeEvents(entry.filters, {
      onEvent(event, info: RuntimeEventInfo) { const verified=publicEvent(event); if (active() && verified) entry.handlers.onEvent(verified,info); },
      onEose(status: RuntimeCompletion) { if(active()) entry.handlers.onEose?.(status); },
      onError(error) { if(active()) entry.handlers.onError?.(error); },
    });
  }
  function failed(error=new Error('Connection interrupted. Reconnecting…')) {
    if (closed || restart) return;
    generation++;
    const previous=client??initializing; client=null;initializing=null; starting=null;
    for(const query of queries) query.abort(error);
    for(const entry of subscriptions) { entry.handle?.close(); entry.handle=undefined; entry.handlers.onError?.(new Error('Connection interrupted. Reconnecting…')); }
    void previous?.close().catch(()=>{});
    if (++retries <= 3) restart=setTimeout(()=>{restart=null;void ready().catch(()=>{});},retryMs*retries);
  }
  async function ready(): Promise<PublicWorkerClient> {
    if (closed) throw cancelled();
    if (client) return client;
    if (starting) return starting;
    const version=generation;
    const task=(async()=>{
      const next=await (createClient ? createClient(failed) : createPublicWorkerClient(relays,failed));
      if(closed || version!==generation) { void next.close().catch(()=>{}); throw cancelled(); }
      initializing=next;
      try { await next.init(); }
      catch(error) { void next.close().catch(()=>{}); throw error; }
      finally{if(initializing===next)initializing=null;}
      if(closed || version!==generation) { void next.close().catch(()=>{}); throw cancelled(); }
      client=next;
      if(source) await next.setNostrSource(source);
      for(const entry of subscriptions) bind(entry,next);
      return next;
    })();
    starting=task;
    try { return await task; }
    catch(error) { if(!closed && version===generation) failed(); throw error; }
    finally { if(starting===task) starting=null; }
  }
  return {
    async query(filters,options={}) {
      const selected=publicFilters(filters);
      if(options.signal?.aborted || closed) throw cancelled();
      const controller=new AbortController(); queries.add(controller);
      const abort=()=>controller.abort(); options.signal?.addEventListener('abort',abort,{once:true});
      let timer:ReturnType<typeof setTimeout> | undefined;
      const timeout = options.deadline === undefined ? 12000 : Math.max(0,options.deadline-Date.now());
      timer=setTimeout(abort,Math.min(timeout+1000,30000));
      try {
        const active=await Promise.race([ready(),new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason??cancelled()),{once:true}))]);
        if(controller.signal.aborted) throw controller.signal.reason??cancelled();
        const result=await active.queryEvents(selected,{...options,signal:controller.signal,limit:Math.min(options.limit??1024,1024)});
        if(controller.signal.aborted) throw controller.signal.reason??cancelled();
        if(closed)throw cancelled();
        return {...result,events:result.events.map(publicEvent).filter((event):event is VerifiedEvent=>!!event)};
      } finally { clearTimeout(timer);queries.delete(controller);options.signal?.removeEventListener('abort',abort); }
    },
    subscribe(filters,handlers) {
      const entry={filters:publicFilters(filters),handlers,handle:undefined as RuntimeSubscription|undefined};
      if(closed) return {close(){}};
      subscriptions.add(entry);
      if(client) bind(entry,client); else void ready().catch(error=>{if(subscriptions.has(entry)) handlers.onError?.(error);});
      return {close(){subscriptions.delete(entry);entry.handle?.close();}};
    },
    async publish(input) {
      const event=publicEvent(input); if(!event) throw new Error('Invalid public event.');
      return (await ready()).publishEvent(event);
    },
    async ingest(inputs) {
      if(!Array.isArray(inputs)||inputs.length>128)throw new Error('Public event import is too large.');
      const events=inputs.map(publicEvent);
      if(events.some(event=>!event))throw new Error('Only signed public records belong in this cache.');
      await (await ready()).ingestEvents(events as Event[]);
    },
    async setSources(sources) {
      // RelayWorkerClient has one source port; a mesh provider can aggregate peers.
      if(!Array.isArray(sources)||sources.length>1) throw new Error('Choose one public peer provider.');
      source=sources[0]?publicIndexSource(sources[0]):null;
      if(client)await client.setNostrSource(source);else await ready();
    },
    close() {
      if(closed) return;closed=true;generation++;clearTimeout(restart);
      for(const query of queries) query.abort();
      for(const entry of subscriptions) entry.handle?.close();subscriptions.clear();
      void (client??initializing)?.close().catch(()=>{});client=null;initializing=null;
    },
  };
}

const shared = new Map<string,PublicEventRuntime>();
const indexes = new Map<string,ReturnType<typeof createPublicIndex>>();
export function getPublicRuntime(relays: readonly string[]): PublicEventRuntime {
  const normalized=[...new Set(relays)].sort(), key=JSON.stringify(normalized);
  let runtime=shared.get(key);
  if(!runtime) {
    runtime=createPublicRuntime({relays:normalized});shared.set(key,runtime);
    const owner=runtime;
    const index=createPublicIndex({queryRoots:(filters,options)=>owner.query(filters,{...options,relays:normalized})});
    indexes.set(key,index);void owner.setSources([index.source]).catch(()=>{});
  }
  return runtime;
}

/** Preserve signed expired revisions until pubsub supports their tombstone admission. */
export async function queryPublicIndex(relays:readonly string[],filters:Filter[],options:RuntimeQueryOptions={}) {
  const key=JSON.stringify([...new Set(relays)].sort());getPublicRuntime(relays);
  const report=await indexes.get(key)!.query(filters,options);
  return {...report,events:report.events.map(record=>record.event)};
}
