import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex} from '@noble/hashes/utils.js'
import type {FeedDecision} from './types.ts'

export const DECISION_CACHE_LIMIT=2048
export const DECISION_CACHE_TTL=24*60*60*1000
const encoder=new TextEncoder()
const hash=(value:string)=>bytesToHex(sha256(encoder.encode(value)))
export function decisionCacheKey({model,revision,device,dtype,filterVersion,condition,content,truncated,eventId}:{model:string;revision:string;device:string;dtype:string;filterVersion:number;condition:string;content:string;truncated:boolean;eventId?:string}) {
  // Neither the search text nor the public listing text is retained in storage.
  return hash(JSON.stringify([1,model,revision,device,dtype,filterVersion,hash(condition),hash(content),truncated,eventId??null]))
}

export interface DecisionCacheRecord {key:string;decision:Readonly<FeedDecision>;createdAt:number;accessedAt:number}
export interface DecisionCacheStore {
  load(limit:number):Promise<unknown[]>
  write(records:DecisionCacheRecord[],removed:string[],options:{now:number;limit:number;ttl:number}):Promise<void>
}
function decision(value:unknown):Readonly<FeedDecision>|null {
  if(!value||typeof value!=='object')return null
  const item=value as Partial<FeedDecision>
  if(typeof item.score!=='number'||!Number.isFinite(item.score)||item.score<0||item.score>1)return null
  return Object.freeze({score:item.score,show:item.score>=.5,truncated:item.truncated===true,
    milliseconds:Number.isFinite(item.milliseconds)&&item.milliseconds>=0?item.milliseconds:0,
    inputTokens:Number.isSafeInteger(item.inputTokens)&&item.inputTokens>=0?item.inputTokens:0})
}
function record(value:unknown,now:number,ttl:number):DecisionCacheRecord|null {
  if(!value||typeof value!=='object')return null
  const item=value as Partial<DecisionCacheRecord>,result=decision(item.decision)
  if(!/^[a-f0-9]{64}$/.test(item.key??'')||!result||!Number.isSafeInteger(item.createdAt)||item.createdAt<0||item.createdAt>now||now-item.createdAt>=ttl||!Number.isSafeInteger(item.accessedAt)||item.accessedAt<item.createdAt||item.accessedAt>now)return null
  return {key:item.key,decision:result,createdAt:item.createdAt,accessedAt:item.accessedAt}
}

/** Optional public-decision storage; deliberately separate from the private vault. */
export function indexedDecisionStore(factory?:IDBFactory):DecisionCacheStore|null {
  try{factory??=globalThis.indexedDB}catch{return null}
  if(!factory)return null
  let database:Promise<IDBDatabase>|undefined
  const open=()=>database??=new Promise<IDBDatabase>((resolve,reject)=>{
    const request=factory.open('iris-market-ai-decisions',1)
    request.onupgradeneeded=()=>{const store=request.result.createObjectStore('decisions',{keyPath:'key'});store.createIndex('accessedAt','accessedAt')}
    let blocked=false
    request.onsuccess=()=>{if(blocked){request.result.close();return}request.result.onversionchange=()=>request.result.close();resolve(request.result)}
    request.onerror=()=>reject(request.error)
    request.onblocked=()=>{blocked=true;reject(new Error('Decision storage is busy'))}
  })
  return {
    async load(limit){
      const db=await open()
      return new Promise<unknown[]>((resolve,reject)=>{
        const transaction=db.transaction('decisions','readonly'),rows:unknown[]=[]
        const cursor=transaction.objectStore('decisions').index('accessedAt').openCursor(null,'prev')
        cursor.onsuccess=()=>{const item=cursor.result;if(item&&rows.length<limit){rows.push(item.value);item.continue()}}
        transaction.oncomplete=()=>resolve(rows)
        transaction.onerror=transaction.onabort=()=>reject(transaction.error)
      })
    },
    async write(records,removed,{now,limit,ttl}){
      const db=await open()
      return new Promise<void>((resolve,reject)=>{
        const transaction=db.transaction('decisions','readwrite'),store=transaction.objectStore('decisions')
        for(const key of removed)store.delete(key)
        for(const value of records)store.put(value)
        // One serialized transaction enforces the persistent cap across tabs.
        // Normal storage has at most limit + one bounded write batch to visit.
        const retained:DecisionCacheRecord[]=[]
        const trim=()=>{retained.sort((a,b)=>b.accessedAt-a.accessedAt||a.key.localeCompare(b.key));for(const value of retained.splice(limit))store.delete(value.key)}
        const cursor=store.openCursor()
        cursor.onsuccess=()=>{
          const item=cursor.result
          if(!item){trim();return}
          const value=record(item.value,now,ttl)
          if(!value)item.delete();else retained.push(value)
          if(retained.length>limit*2)trim()
          item.continue()
        }
        transaction.oncomplete=()=>resolve()
        transaction.onerror=transaction.onabort=()=>reject(transaction.error)
      })
    },
  }
}

/** Reads never await IndexedDB. A cold or unavailable cache is simply a miss. */
export class DecisionCache {
  private entries=new Map<string,DecisionCacheRecord>()
  private updates=new Map<string,DecisionCacheRecord>()
  private removed=new Set<string>()
  private timer:ReturnType<typeof setTimeout>|undefined
  private writing:Promise<void>|undefined
  private failed=false
  private maintenance=false
  readonly ready:Promise<void>
  readonly limit:number
  readonly ttl:number
  private store:DecisionCacheStore|null
  private now:()=>number
  private delay:number
  constructor({store=indexedDecisionStore(),limit=DECISION_CACHE_LIMIT,ttl=DECISION_CACHE_TTL,now=Date.now,delay=750}:{store?:DecisionCacheStore|null;limit?:number;ttl?:number;now?:()=>number;delay?:number}={}){
    this.store=store;this.now=now;this.limit=Math.max(1,Math.min(DECISION_CACHE_LIMIT,Math.floor(limit)||DECISION_CACHE_LIMIT));this.ttl=Math.max(1,Math.min(DECISION_CACHE_TTL,ttl));this.delay=delay
    this.ready=store?Promise.resolve().then(()=>store.load(this.limit)).then(rows=>{
      const current=[...this.entries.values()],time=this.now(),loaded=rows.slice(0,this.limit).map(value=>record(value,time,this.ttl)).filter((value):value is DecisionCacheRecord=>!!value).sort((a,b)=>a.accessedAt-b.accessedAt||a.key.localeCompare(b.key))
      this.entries.clear()
      for(const value of [...loaded,...current]){if(this.removed.has(value.key))continue;this.entries.delete(value.key);this.entries.set(value.key,value)}
      this.trim();this.maintenance=true;this.schedule()
    }).catch(()=>{this.failed=true;this.updates.clear();this.removed.clear()}):Promise.resolve()
  }
  get size(){return this.entries.size}
  get(key:string):Readonly<FeedDecision>|undefined {
    const value=this.entries.get(key)
    if(!value)return undefined
    const time=this.now()
    if(!record(value,time,this.ttl)){this.remove(key);return undefined}
    const touched={...value,accessedAt:time};this.entries.delete(key);this.entries.set(key,touched)
    if(value.accessedAt!==time&&this.store&&!this.failed){this.updates.set(key,touched);this.schedule()}
    return touched.decision
  }
  set(key:string,value:unknown):boolean {
    const result=decision(value)
    if(!/^[a-f0-9]{64}$/.test(key)||!result)return false
    const time=this.now(),next={key,decision:result,createdAt:time,accessedAt:time}
    this.entries.delete(key);this.entries.set(key,next);this.removed.delete(key);if(this.store&&!this.failed)this.updates.set(key,next);this.trim();this.schedule();return true
  }
  private remove(key:string){this.entries.delete(key);this.updates.delete(key);if(this.store&&!this.failed){this.removed.add(key);while(this.removed.size>this.limit)this.removed.delete(this.removed.values().next().value);this.schedule()}}
  private trim(){while(this.entries.size>this.limit)this.remove(this.entries.keys().next().value)}
  private schedule(){if(!this.store||this.failed||this.timer||this.writing||(!this.updates.size&&!this.removed.size&&!this.maintenance))return;this.timer=setTimeout(()=>{this.timer=undefined;void this.flush()},this.delay);(this.timer as unknown as {unref?:()=>void}).unref?.()}
  flush():Promise<void>{
    if(this.timer){clearTimeout(this.timer);this.timer=undefined}
    if(this.writing)return this.writing
    if(!this.store||this.failed)return Promise.resolve()
    const updates=[...this.updates.values()],removed=[...this.removed],maintenance=this.maintenance;this.updates.clear();this.removed.clear();this.maintenance=false
    if(!updates.length&&!removed.length&&!maintenance)return Promise.resolve()
    this.writing=Promise.resolve().then(()=>this.store.write(updates,removed,{now:this.now(),limit:this.limit,ttl:this.ttl})).catch(()=>{this.failed=true;this.updates.clear();this.removed.clear()}).finally(()=>{this.writing=undefined;this.schedule()})
    return this.writing
  }
}
