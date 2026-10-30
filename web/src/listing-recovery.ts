import {verifyEvent, type Event, type Filter} from 'nostr-tools';
import type {PublicEventRuntime} from './nostr-runtime.ts';

interface Options {
  runtime: Pick<PublicEventRuntime,'ingest'|'subscribe'>;
  readCache:()=>Promise<Event[]>;
  readMemory?:()=>readonly Event[];
  onEvent:(event:Event)=>void;
  windowMs?:number;
  now?:()=>number;
}

/** Background gap recovery shares the public worker's retained event store.
 * Ordinary listing requests and their pagination remain independent. */
export function createListingRecovery({runtime,readCache,readMemory=()=>[],onEvent,windowMs=5000,now=Date.now}:Options) {
  const pending=new Map<string,Event>(),imported=new Set<string>();
  const active=new Set<()=>void>(),attempts=new Map<string,number>();
  let closed=false,seeded=false,seeding:Promise<void>|undefined,writing:Promise<void>|undefined;
  function retained(input:Event):Event|null {
    try {
      const event={id:input.id,pubkey:input.pubkey,kind:input.kind,created_at:input.created_at,
        content:input.content,tags:input.tags.map(tag=>[...tag]),sig:input.sig};
      if(event.kind!==30402||new TextEncoder().encode(JSON.stringify(event)).length>65536||!verifyEvent(event))return null;
      const expiry=event.tags.filter(tag=>tag[0]==='expiration');
      // The shared worker excludes expired records. Market's own authoritative
      // cache retains them; do not claim they entered the compared inventory.
      if(expiry.length&&(expiry.length!==1||!/^\d+$/.test(expiry[0][1]??'')||!Number.isSafeInteger(Number(expiry[0][1]))||Number(expiry[0][1])<=Math.floor(now()/1000)))return null;
      return event;
    }catch{return null;}
  }
  const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
  function idOf(input:Event):string|undefined {try{const id=input?.id;return typeof id==='string'?id:undefined;}catch{return undefined;}}
  function observe(input:Event):boolean {
    const id=idOf(input);
    // An identical event ID cannot authorize different bytes. Keep the verified
    // original without reparsing a repeated or malicious duplicate payload.
    if(closed||!id||imported.has(id)||pending.has(id)||pending.size>=2000)return false;
    const event=retained(input);
    if(event)pending.set(event.id,event);
    if(event&&seeded)void flush().catch(()=>{});
    return true;
  }
  async function collect(inputs:readonly Event[],skip:ReadonlyMap<string,Event>=new Map()) {
    const result=new Map<string,Event>();let checked=0;
    for(const input of inputs){
      if(closed)break;
      const id=idOf(input);
      if(!id||imported.has(id)||skip.has(id)||result.has(id))continue;
      const known=pending.get(id),event=known??retained(input);
      if(event)result.set(id,event);
      if(!known&&++checked%32===0)await pause();
    }
    return result;
  }
  function flush():Promise<void> {
    if(writing)return writing;
    writing=(async()=>{
      while(!closed&&pending.size){
        // Each verified Market event is at most 64 KiB; 16 fit below the 2 MiB worker limit.
        const batch=[...pending.values()].slice(0,16);
        await runtime.ingest(batch);
        for(const event of batch){pending.delete(event.id);imported.add(event.id);}
        while(imported.size>2000)imported.delete(imported.values().next().value!);
      }
    })().finally(()=>{writing=undefined;});
    return writing;
  }
  function seed():Promise<void> {
    if(seeding)return seeding;
    seeding=(async()=>{
      const disk=(await readCache()).slice(0,1000);
      if(closed)return;
      // A missing/disabled disk cache cannot erase the current in-memory baseline.
      // Prioritize current memory and live arrivals when the merge reaches its cap.
      const memory=await collect(readMemory().slice(0,1000));
      const cached=await collect(disk,memory);
      if(closed)return;
      const merged=new Map<string,Event>();
      // Read pending again after yielding so live arrivals during verification
      // remain ahead of older disk records instead of being overwritten.
      for(const event of [...memory.values(),...pending.values(),...cached.values()]){
        if(!imported.has(event.id)&&!merged.has(event.id)&&merged.size<2000)merged.set(event.id,event);
      }
      pending.clear();for(const [id,event] of merged)pending.set(id,event);
      await flush();seeded=true;
    })().catch(error=>{seeding=undefined;throw error;});
    return seeding;
  }
  async function recover(filter:Filter) {
    if(closed||active.size>=2||filter.search||filter.ids||filter.kinds?.some(kind=>kind!==30402))return;
    const scoped={...filter,kinds:[30402],limit:1};
    const key=JSON.stringify(scoped),time=now();
    for(const [key,expires] of attempts)if(expires<=time)attempts.delete(key);
    if(attempts.has(key)||attempts.size>=64)return;
    attempts.set(key,time+300000);
    try {
      // A failed cache import skips recovery; never compare a knowingly empty substitute.
      await seed();
      let checked=0;
      for(const event of readMemory().slice(0,1000)){
        if(observe(event)&&++checked%32===0)await pause();
        if(closed)return;
      }
      await flush();
      if(closed||active.size>=2)return;
      let live=true;
      const subscription=runtime.subscribe([scoped],{onEvent:event=>{if(!closed&&live)onEvent(event);}});
      const stop=()=>{live=false;clearTimeout(timer);subscription.close();active.delete(stop);};
      const timer=setTimeout(stop,windowMs);active.add(stop);
    }catch(error){console.debug('Listing recovery skipped:',error);/* Ordinary browsing continues. */}
  }
  return {observe,recover,close(){closed=true;for(const stop of [...active])stop();pending.clear();}};
}
