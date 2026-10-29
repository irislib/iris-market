import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure'
import { locationFromTags, MAX_GEOHASH_QUERY_VALUES } from './map/geohash.ts'
import { queryPublicIndex } from './nostr-runtime.ts'
import type { Filter } from 'nostr-tools'
import type { RuntimeQueryOptions } from 'nostr-pubsub'
import { SeenTags, observedMarketTags, TAG_LIMITS } from './seen-tags.ts'
import {publicListingCache,type PublicListingCache} from './offline-listings.ts'
import {parseServiceAreas} from './service-area.ts'

export const DEFAULT_RELAYS = Object.freeze(['wss://temp.iris.to', 'wss://vault.iris.to', 'wss://relay.damus.io', 'wss://relay.snort.social', 'wss://relay.primal.net', 'wss://nos.lol'])
export const LISTING_KIND = 30402
export const MAX_RECORDS = 1000
const MAX_EVENT_BYTES = 65536
const MAX_FRAME_BYTES = MAX_EVENT_BYTES + 2048
const HISTORY_PAGE_SIZE = 300
const HISTORY_TIMEOUT = 12000
const MAX_HISTORY_REQUESTS = 32
const MAX_HISTORY_BYTES = 16 * 1024 * 1024
const GEO_QUERY_LIMIT = 120
const encoder = new TextEncoder()
const seconds = () => Math.floor(Date.now() / 1000)
const length = value => Array.from(value).length
const bytes = value => encoder.encode(value).length
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(value)
const fail = (message: string): never => { throw new Error(message) }

function singleton(event: NostrEvent, name: string) {
  const tags = event.tags.filter(tag => tag[0] === name)
  if (tags.length > 1) fail(`Duplicate ${name} field`)
  return tags[0]?.[1]
}

/** Verify and normalise a NIP-99 record. Sold/expired records are valid tombstones. */
export function parseEvent(input: NostrEvent, { now = seconds() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid listing event')
  if (input.kind !== LISTING_KIND) fail('Not a classified listing')
  if (!Number.isSafeInteger(input.created_at) || input.created_at < 0 || input.created_at > now + 300) fail('Invalid listing timestamp')
  if (!hex(input.id, 64) || !hex(input.pubkey, 64) || !hex(input.sig, 128)) fail('Invalid listing signature fields')
  if (typeof input.content !== 'string' || !Array.isArray(input.tags) || input.tags.length > 2048) fail('Invalid listing fields')
  if (!input.tags.every(tag => Array.isArray(tag) && tag.length > 0 && tag.every(value => typeof value === 'string'))) fail('Invalid listing tags')
  // Copy only wire fields: never trust nostr-tools' cached verification Symbol on
  // a mutable object passed by another caller. No getters/symbols enter storage.
  const event = {
    id: input.id, pubkey: input.pubkey, created_at: input.created_at,
    kind: input.kind, tags: input.tags.map(tag => [...tag]), content: input.content, sig: input.sig,
  }
  if (bytes(JSON.stringify(event)) > MAX_EVENT_BYTES) fail('Listing is too large')
  if (!verifyEvent(event)) fail('Listing signature is invalid')

  const identifier = singleton(event, 'd')
  if (!identifier || bytes(identifier) > 160) fail('Invalid listing identifier')
  const title = singleton(event, 'title')
  if (typeof title !== 'string' || !title.trim() || length(title) > 160) fail('Invalid listing title')
  if (bytes(event.content) > 12000) fail('Description is too long')
  const side = singleton(event, 'market') ?? (event.tags.some(tag=>tag[0]==='t'&&tag[1]==='market:request')?'request':'offer')
  if (side !== 'offer' && side !== 'request') fail('Invalid listing type')
  const location = singleton(event, 'location') ?? ''
  const geo = locationFromTags(event.tags)
  const tags = event.tags.filter(tag => tag[0] === 't' && typeof tag[1] === 'string' && !tag[1].startsWith('market:')).map(tag => tag[1])
  const category = tags[0] ?? 'Other'
  if (length(location) > 160 || length(category) > 60) fail('Location or category is too long')
  const price = singleton(event, 'price') ?? ''
  const currency = event.tags.find(tag => tag[0] === 'price')?.[2] ?? 'EUR'
  if (!/^[a-zA-Z]{3,12}$/.test(currency)) fail('Invalid currency')
  if (price !== '' && (bytes(price) > 24 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(price) || !Number.isFinite(Number(price)) || Number(price) < 0)) fail('Invalid price')
  const rawImage = event.tags.find(tag => tag[0] === 'image')?.[1]
  let imageUrl = null
  if (rawImage) {
    let image
    try { image = new URL(rawImage) } catch { fail('Invalid image URL') }
    if (image.protocol !== 'https:' || !image.hostname || image.username || image.password) fail('Images need an HTTPS URL without credentials')
    imageUrl = image.href
  }
  const rawExpiration = singleton(event, 'expiration')
  let expiration = null
  if (rawExpiration !== undefined) {
    if (!/^\+?\d+$/.test(rawExpiration)) fail('Invalid expiry')
    expiration = Number(rawExpiration)
    if (!Number.isSafeInteger(expiration) || expiration < 0) fail('Invalid expiry')
  }
  const status = singleton(event, 'status') ?? 'active'
  if (status !== 'active' && status !== 'sold') fail('Invalid listing status')
  const originalTags = Object.freeze(event.tags.map(tag => Object.freeze([...tag])))
  const rawEvent = Object.freeze({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: originalTags, content: event.content, sig: event.sig })
  return Object.freeze({
    rawEvent, id: `${event.pubkey}:${identifier}`, eventId: event.id, author: event.pubkey,
    identifier, title, description: event.content, price, currency, location,
    geohash: geo?.geohash ?? null, coordinates: geo?.coordinates ?? null, locationBounds: geo?.bounds ?? null,
    serviceAreas: parseServiceAreas(event.tags),
    category, tags: Object.freeze(tags), originalTags, imageUrl, side, createdAt: event.created_at, expiration, status,
  })
}

/** NIP-01 tie break: the lowest event ID wins equal timestamps. */
export function isNewer(candidate, previous) {
  return !previous || candidate.createdAt > previous.createdAt ||
    (candidate.createdAt === previous.createdAt && candidate.eventId < previous.eventId)
}

function applyListing(records: Map<string, MarketListing>, listing: MarketListing, maxRecords: number) {
  const previous = records.get(listing.id)
  if (!isNewer(listing, previous)) return false
  // Do not evict tombstones to make room: an older relay replay could otherwise
  // resurrect a sold/expired listing. The bound is per browser client lifetime.
  if (!previous && records.size >= maxRecords) return false
  records.set(listing.id, listing)
  return true
}

/** Mutates a caller-owned Map only after successful signature/field validation. */
export function applyEvent(records: Map<string, MarketListing>, event: NostrEvent, { now = seconds(), maxRecords = MAX_RECORDS } = {}) {
  if (!(records instanceof Map)) fail('Listing store must be a Map')
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 5000) fail('Invalid listing capacity')
  return applyListing(records, parseEvent(event, { now }), maxRecords)
}

export function visibleListings(records: Map<string, MarketListing>, { now = seconds() } = {}) {
  return [...records.values()]
    .filter(item => item.status === 'active' && (item.expiration === null || item.expiration > now))
    .sort((a, b) => b.createdAt - a.createdAt || a.eventId.localeCompare(b.eventId))
}

export function validateRelays(relays: readonly string[]): string[] {
  if (!Array.isArray(relays) || relays.length > 8) fail('Choose up to eight message servers')
  return [...new Set(relays.map(value => {
    if (typeof value !== 'string' || value.length > 2048) fail('Invalid message server URL')
    let url
    try { url = new URL(value) } catch { fail('Invalid message server URL') }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (!url.hostname || url.username || url.password || url.hash ||
      !(url.protocol === 'wss:' || (url.protocol === 'ws:' && local))) fail('Use a secure wss:// message server')
    return url.href
  }))]
}

function feedTags(tags: readonly string[]) {
  if (!Array.isArray(tags) || tags.length > 8 || tags.some(tag => typeof tag !== 'string' || !tag || length(tag) > 60)) fail('Choose up to eight exact tags, each at most 60 characters')
  return Object.freeze([...new Set(tags)])
}

function feedAuthors(authors: readonly string[] | null) {
  if (authors === null) return null
  if (!Array.isArray(authors) || authors.length > 256 || authors.some(author => !hex(author, 64))) fail('Choose up to 256 public authors')
  return Object.freeze([...new Set(authors)])
}

function targetFilter(targetId?: string | null): MarketFilter | null {
  if (targetId === undefined || targetId === null) return null
  if (typeof targetId !== 'string' || targetId[64] !== ':' || !hex(targetId.slice(0, 64), 64)) fail('Invalid listing link')
  const identifier = targetId.slice(65)
  if (!identifier || bytes(identifier) > 160) fail('Invalid listing link')
  return { kinds: [LISTING_KIND], authors: [targetId.slice(0, 64)], '#d': [identifier], limit: 1 }
}

export type MarketListing = ReturnType<typeof parseEvent>
export interface MarketFilter {
  kinds: number[]
  authors?: readonly string[]
  '#d'?: string[]
  '#t'?: readonly string[]
  '#g'?: string[]
  until?: number
  limit: number
}
export interface MarketPagination { loading: boolean; exhausted: boolean; limited: boolean; hasMore: boolean; error: string; added: number; records: number }
export interface MarketStatus { state: 'closed' | 'empty' | 'live' | 'connecting' | 'offline'; connected: number; total: number; message: string }
interface RelayHistory { initialOldest: number | null; cursor: number | null; started: boolean; exhausted: boolean; limited: boolean; requests: number }
interface HistoryPage { error?: string; limited?: boolean; count?: number; oldest?: number | null }
interface HistoryOptions { tags?:readonly string[];signal?:AbortSignal;pageSize?:number;maxRequests?:number;rounds?:number;timeoutMs?:number;budget?:{bytes:number;max:number};requestBudget?:{count:number;max:number} }
interface QueryTagPlan {tags:readonly string[];history:Map<string,RelayHistory>;indexHistory:RelayHistory}
export interface QueryCandidates {loading:boolean;added:number;hasMore:boolean;error:string;limited:boolean}
interface RelayConnection {
  url: string; attempt: number; socket: WebSocket | null; failed: boolean; ready: boolean; subscription: string
  timer: ReturnType<typeof setTimeout> | null; retry: ReturnType<typeof setTimeout> | null
  frameStart: number; frames: number; geoSubscription?: string | null; geoSubscriptions?: Set<string>
}
export interface MarketRelayOptions {
  relays?: readonly string[]; tags?: readonly string[]; authors?: readonly string[] | null; targetId?: string
  onChange?: (listings: MarketListing[]) => void; onStatus?: (status: MarketStatus) => void; onPagination?: (pagination: MarketPagination) => void
  historyPageSize?: number; records?: Map<string, MarketListing>; maxRecords?: number
  WebSocketImpl?: typeof WebSocket; now?: () => number
  indexQuery?: ((filters:Filter[],options:RuntimeQueryOptions)=>Promise<{events:NostrEvent[];complete?:boolean}>) | null
  tagCatalogue?: SeenTags
  offlineCache?: PublicListingCache | null
}

/** Complete precision covers, split below common relay frame/subscription limits. */
export function geographicRequests(values:readonly string[],{authors=null,tags=[]}:{authors?:readonly string[]|null;tags?:readonly string[]}={}):MarketFilter[][] {
  const groups=new Map<number,string[]>();
  for(const hash of values){if(!groups.has(hash.length))groups.set(hash.length,[]);groups.get(hash.length).push(hash);}
  let selected:string[][]=[],accepted:MarketFilter[][]=[];
  for(const [,cover] of [...groups].sort(([a],[b])=>a-b)){
    const candidate=[...selected];for(let start=0;start<cover.length;start+=512)candidate.push(cover.slice(start,start+512));
    const limit=Math.min(GEO_QUERY_LIMIT,Math.floor(240/candidate.length));
    const filters:MarketFilter[]=candidate.map(cells=>({kinds:[LISTING_KIND],'#g':cells,limit,...(authors!==null?{authors}:{}),...(tags.length?{'#t':tags}:{})}));
    const batches:MarketFilter[][]=[];let batch:MarketFilter[]=[];
    for(const filter of filters){
      if(batch.length&&(batch.length===8||bytes(JSON.stringify(['REQ','map-0000000000000000',...batch,filter]))>28*1024)){batches.push(batch);batch=[];}
      batch.push(filter);
    }
    if(batch.length)batches.push(batch);
    // Never trim a fine cover to its western/first cells: keep the preceding
    // whole covers when an audience or long tags consume the frame budget.
    if(batches.length>9||batches.some(value=>bytes(JSON.stringify(['REQ','map-0000000000000000',...value]))>28*1024))break;
    selected=candidate;accepted=batches;
  }
  return accepted;
}

/** Read-only relay client. Holds no signing keys and never publishes. */
export class MarketRelayClient {
  relays: string[]
  tags: readonly string[]
  authors: readonly string[] | null
  authorSet: Set<string> | null
  targetFilter: MarketFilter | null
  targetId: string | null
  hasInventoryQuery: boolean
  hasQueries: boolean
  records: Map<string, MarketListing>
  maxRecords: number
  onChange: NonNullable<MarketRelayOptions['onChange']>
  onStatus: NonNullable<MarketRelayOptions['onStatus']>
  onPagination: NonNullable<MarketRelayOptions['onPagination']>
  historyPageSize: number
  history: Map<string, RelayHistory>
  historyReaders: Set<(page: HistoryPage) => void>
  pagePromise: Promise<MarketPagination> | null
  pageLoading: boolean
  pageError: string
  pageAdded: number
  lastPagination: string
  WebSocket: typeof WebSocket
  now: () => number
  running: boolean
  connections: Map<string, RelayConnection>
  seen: Set<string>
  changeTimer: ReturnType<typeof setTimeout> | null
  expiryTimer: ReturnType<typeof setInterval> | null
  lastVisible: string | null
  lastStatus: string
  geohashes: string[]
  geohashSet = new Set<string>()
  geoSequence: number
  indexQuery: MarketRelayOptions['indexQuery']
  indexReads = new Set<AbortController>()
  indexRequests = 0
  indexBytes = 0
  tagCatalogue: SeenTags
  queryTags:readonly string[]=[]
  queryPlans:QueryTagPlan[]=[]
  queryExtraTags:readonly string[]=[]
  queryRequestBudget={count:0,max:32}
  queryController=new AbortController()
  queryPromise:Promise<QueryCandidates>|null=null
  queryBudget={bytes:0,max:8*1024*1024}
  queryAdded=0
  queryError=''
  queryText=''
  tagSelectionTimer:ReturnType<typeof setTimeout>|null=null
  offlineCache:PublicListingCache|null
  cacheGeneration=0
  constructor({ relays = DEFAULT_RELAYS, onChange = () => {}, onStatus = () => {}, onPagination = () => {}, historyPageSize = HISTORY_PAGE_SIZE, records = new Map(), maxRecords = MAX_RECORDS, WebSocketImpl, now = seconds, targetId, tags = [], authors = null, indexQuery, tagCatalogue=observedMarketTags,offlineCache }: MarketRelayOptions = {}) {
    this.relays = validateRelays(relays)
    this.tags = feedTags(tags)
    this.authors = feedAuthors(authors)
    this.authorSet = this.authors === null ? null : new Set(this.authors)
    if (!(records instanceof Map) || records.size > maxRecords) fail('Invalid listing store')
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) fail('Invalid listing capacity')
    if (!Number.isSafeInteger(historyPageSize) || historyPageSize < 1 || historyPageSize > HISTORY_PAGE_SIZE) fail('Invalid history page size')
    this.targetFilter = targetFilter(targetId)
    this.targetId = this.targetFilter ? targetId : null
    this.hasInventoryQuery = this.authors === null || this.authors.length > 0
    this.hasQueries = this.hasInventoryQuery || this.targetFilter !== null
    if (this.targetId && !records.has(this.targetId) && records.size >= maxRecords) fail('Leave room in the listing store for the shared listing')
    this.records = records
    this.maxRecords = maxRecords
    this.onChange = onChange
    this.onStatus = onStatus
    this.onPagination = onPagination
    this.historyPageSize = Math.min(historyPageSize, maxRecords)
    this.history = new Map(this.relays.map(url => [url, { initialOldest: null, cursor: null, started: false, exhausted: false, limited: false, requests: 0 }]))
    this.historyReaders = new Set()
    this.pagePromise = null
    this.pageLoading = false
    this.pageError = ''
    this.pageAdded = 0
    this.lastPagination = ''
    this.WebSocket = WebSocketImpl ?? globalThis.WebSocket
    this.indexQuery = indexQuery===undefined ? (WebSocketImpl ? null : (filters,options)=>queryPublicIndex(this.relays,filters,options)) : indexQuery
    this.tagCatalogue=tagCatalogue
    this.offlineCache=offlineCache===undefined?(WebSocketImpl?null:publicListingCache(event=>parseEvent(event))):offlineCache
    this.now = now
    this.running = false
    this.connections = new Map()
    this.seen = new Set()
    this.changeTimer = null
    this.expiryTimer = null
    this.lastVisible = null
    this.lastStatus = ''
    this.geohashes = []
    this.geoSequence = 0
  }

  start() {
    if (this.running) return this
    if(this.queryController.signal.aborted){this.queryController=new AbortController();this.queryPromise=null}
    if (this.hasQueries && typeof this.WebSocket !== 'function') fail('This browser cannot connect to message servers')
    this.running = true
    void this.restoreOffline(++this.cacheGeneration)
    if (this.hasQueries) for (const url of this.relays) this.connect(url)
    this.requestIndex()
    this.emitStatus()
    this.emitChange()
    this.emitPagination()
    if (this.hasQueries) this.expiryTimer = setInterval(() => this.emitChange(), 1000)
    return this
  }

  matchesFeed(listing: MarketListing) {
    return (this.authorSet === null || this.authorSet.has(listing.author)) &&
      (!this.tags.length || this.tags.some(tag => listing.tags?.includes(tag)))
  }

  listings() {
    return visibleListings(this.records, { now: this.now() })
      .filter(listing => listing.id === this.targetId || this.matchesFeed(listing))
  }

  parseIncoming(event:NostrEvent):MarketListing {
    const listing=parseEvent(event,{now:this.now()});this.tagCatalogue.observe(event,this.now())
    this.offlineCache?.save(event)
    if(this.running&&this.queryText&&this.queryTags.length<TAG_LIMITS.queryTags&&this.tagSelectionTimer===null)this.tagSelectionTimer=setTimeout(()=>{
      this.tagSelectionTimer=null;if(this.running)this.searchTags(this.queryText)
    },24)
    return listing
  }

  async restoreOffline(generation:number){
    if(!this.offlineCache)return
    try{
      const events=await this.offlineCache.load()
      for(let i=0;i<events.length;i++){
        if(!this.running||generation!==this.cacheGeneration)return
        try{this.acceptListing(parseEvent(events[i],{now:this.now()}))}catch{/* Cached records require fresh verification. */}
        if(i%32===31)await new Promise(resolve=>setTimeout(resolve,0))
      }
    }catch{/* Offline storage is optional; live browsing remains available. */}
  }

  /** Broaden candidate retrieval without using the query as a title predicate. */
  searchTags(query:string,extraTags?:readonly string[]):readonly string[] {
    const text=typeof query==='string'&&query.length<=TAG_LIMITS.queryChars?query:'',changed=text!==this.queryText
    if(changed)this.queryExtraTags=[]
    this.queryText=text
    if(extraTags!==undefined)this.queryExtraTags=Array.isArray(extraTags)?extraTags.slice(0,TAG_LIMITS.queryTags).filter(tag=>typeof tag==='string'&&tag.length<=60):[]
    const proposed=this.tagCatalogue.select(text,TAG_LIMITS.queryTags,this.queryExtraTags)
    // New observations can fill unused slots, but do not repeatedly reshuffle
    // a running search or replenish its finite request/byte budgets.
    const selected=!changed&&extraTags===undefined?[...new Set([...this.queryTags,...proposed])].slice(0,TAG_LIMITS.queryTags):proposed
    return this.applyQueryTags(selected,changed)
  }

  setQueryTags(tags:readonly string[]):readonly string[] {
    const selected=feedTags(tags).filter(tag=>this.tagCatalogue.has(tag))
    this.queryText='';this.queryExtraTags=[]
    return this.applyQueryTags(selected,true)
  }

  private applyQueryTags(tags:readonly string[],reset:boolean):readonly string[] {
    const selected=feedTags(tags)
    if(JSON.stringify(selected)===JSON.stringify(this.queryTags))return this.queryTags
    this.queryController.abort();this.queryController=new AbortController();this.queryPromise=null
    this.queryTags=Object.freeze(selected);this.queryAdded=0;this.queryError=''
    if(reset){this.queryBudget={bytes:0,max:8*1024*1024};this.queryRequestBudget={count:0,max:32}}
    const previous=reset?[]:this.queryPlans,newHistory=():RelayHistory=>({initialOldest:null,cursor:null,started:false,exhausted:false,limited:false,requests:0})
    // Give the direct phrase its own response limit. A broad related tag must
    // not crowd exact matches out of a combined OR query.
    this.queryPlans=[selected.slice(0,1),selected.slice(1)].filter(group=>group.length).map(group=>previous.find(plan=>JSON.stringify(plan.tags)===JSON.stringify(group))??{
      tags:Object.freeze(group),history:new Map(this.relays.map(url=>[url,newHistory()])),indexHistory:{...newHistory(),exhausted:!this.indexQuery},
    })
    if(this.running&&selected.length)void this.loadQueryCandidates()
    return this.queryTags
  }

  queryPagination():QueryCandidates {
    const histories=this.queryPlans.flatMap(plan=>[...plan.history.values(),plan.indexHistory])
    const full=this.records.size>=this.maxRecords||this.queryBudget.bytes>=this.queryBudget.max||this.queryRequestBudget.count>=this.queryRequestBudget.max
    const limited=full||histories.some(item=>item.limited)
    return{loading:!!this.queryPromise,added:this.queryAdded,error:this.queryError,limited,
      hasMore:!!this.queryTags.length&&this.hasInventoryQuery&&!full&&histories.some(item=>!item.exhausted&&!item.limited)}
  }

  /** Finite tag-specific history. The caller chooses how many batches to autoload. */
  loadQueryCandidates():Promise<QueryCandidates> {
    if(this.queryPromise)return this.queryPromise
    if(!this.running||!this.queryPagination().hasMore)return Promise.resolve(this.queryPagination())
    const plans=this.queryPlans,controller=this.queryController,budget=this.queryBudget,requestBudget=this.queryRequestBudget,before=this.records.size
    const options:HistoryOptions={signal:controller.signal,pageSize:80,maxRequests:8,rounds:2,timeoutMs:3500,budget,requestBudget}
    this.queryError='';this.queryAdded=0
    this.queryPromise=Promise.resolve().then(async()=>{
      const results=await Promise.all(plans.flatMap(({tags,history,indexHistory})=>[
        ...[...history].filter(([,item])=>!item.exhausted&&!item.limited).map(([url,item])=>this.loadOlderFrom(url,item,{...options,tags})),
        ...(this.indexQuery&&!indexHistory.exhausted&&!indexHistory.limited?[this.loadQueryIndex(tags,indexHistory,controller.signal,budget,requestBudget)]:[]),
      ]))
      if(controller!==this.queryController)return
      this.queryAdded=Math.max(0,this.records.size-before)
      if(results.some(result=>result.error))this.queryError='Some matching listings could not be loaded.'
    }).catch(()=>{if(controller===this.queryController)this.queryError='Matching listings could not be loaded.'}).finally(()=>{
      if(controller===this.queryController){this.queryPromise=null;if(this.running){this.emitChange();this.onPagination(this.pagination())}}
    }).then(()=>this.queryPagination())
    return this.queryPromise
  }

  async loadQueryIndex(tags:readonly string[],history:RelayHistory,signal:AbortSignal,budget:{bytes:number;max:number},requestBudget:{count:number;max:number}):Promise<HistoryPage> {
    if(requestBudget.count>=requestBudget.max){history.limited=true;return{limited:true}}
    requestBudget.count++
    if(++history.requests>4){history.limited=true;return{limited:true}}
    const until=history.cursor??this.now(),limit=120
    let timer:ReturnType<typeof setTimeout>,abort:()=>void
    try{
      const timeout=new Promise<never>((_,reject)=>{
        abort=()=>reject(new Error('Loading stopped.'));timer=setTimeout(()=>reject(new Error('Matching index read timed out.')),3500)
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
      })
      const report=await Promise.race([this.indexQuery([{kinds:[LISTING_KIND],'#t':[...tags],until,limit,...(this.authors?{authors:[...this.authors]}:{})}],{signal,deadline:Date.now()+3500,limit}),timeout])
      if(signal.aborted||!this.running)return{error:'Loading stopped.'}
      let oldest:number|null=null,count=0
      for(const event of report.events.slice(0,limit)){
        budget.bytes+=bytes(JSON.stringify(event));if(budget.bytes>budget.max){history.limited=true;return{limited:true}}
        try{const listing=this.parseIncoming(event)
          if(listing.createdAt>until||!listing.tags.some(tag=>tags.includes(tag))||(this.authorSet&&!this.authorSet.has(listing.author)))continue
          oldest=Math.min(oldest??listing.createdAt,listing.createdAt);count++;this.acceptListing(listing)
        }catch{/* Invalid index records are not candidates. */}
      }
      if(oldest!==null&&oldest<until)history.cursor=oldest
      else if(count>=limit){history.limited=true;return{limited:true}}
      else if(report.complete){if(count)history.cursor=Math.max(0,until-1);else history.exhausted=true}
      else return{error:'Index history is incomplete.'}
      return{}
    }catch{return{error:'Index history is unavailable.'}}
    finally{clearTimeout(timer);signal.removeEventListener('abort',abort)}
  }

  /** The same verified winner reducer receives durable history and live relay events. */
  requestIndex(extra:Filter[]=[]):void {
    if(!this.running||!this.hasQueries||!this.indexQuery||this.indexReads.size>=2||this.indexRequests>=16||this.indexBytes>=MAX_HISTORY_BYTES)return
    const filters:Filter[]=extra.length?extra:[
      ...(this.hasInventoryQuery?[{kinds:[LISTING_KIND],limit:this.historyPageSize,...(this.authors?{authors:[...this.authors]}:{}),...(this.tags.length?{'#t':[...this.tags]}:{})}]:[]),
      ...(this.targetFilter?[{kinds:[LISTING_KIND],authors:[...this.targetFilter.authors!],'#d':this.targetFilter['#d'],limit:1}]:[]),
    ]
    const controller=new AbortController();this.indexReads.add(controller);this.indexRequests++
    void this.indexQuery(filters,{signal:controller.signal,deadline:Date.now()+6000,limit:Math.min(600,this.maxRecords)}).then(report=>{
      if(!this.running||controller.signal.aborted)return
      for(const event of report.events.slice(0,600)){
        this.indexBytes+=bytes(JSON.stringify(event));if(this.indexBytes>MAX_HISTORY_BYTES)break
        try{this.acceptListing(this.parseIncoming(event))}catch{/* Signature and field errors never enter listings. */}
      }
      this.emitPagination()
    }).catch(()=>{/* Relay results remain available when an index is offline. */}).finally(()=>this.indexReads.delete(controller))
  }

  /** Update only the map discovery subscription; received listings stay usable. */
  setGeohashes(values = []) {
    if (!Array.isArray(values) || values.length > MAX_GEOHASH_QUERY_VALUES || values.some(value => typeof value !== 'string' || !/^[0123456789bcdefghjkmnpqrstuvwxyz]{1,8}$/.test(value))) fail('Invalid map search area')
    const next = [...new Set(values)].sort()
    if (JSON.stringify(next) === JSON.stringify(this.geohashes)) return
    this.geohashes = next
    this.geohashSet = new Set(next)
    if (!this.running) return
    if(next.length&&this.hasInventoryQuery){
      // Keep complete precision covers in the index's smaller query budget.
      const indexed:string[]=[];
      for(const precision of [...new Set(next.map(value=>value.length))].sort((a,b)=>a-b)){
        const cover=next.filter(value=>value.length===precision);if(indexed.length+cover.length>2048)break;indexed.push(...cover);
      }
      this.requestIndex([{kinds:[LISTING_KIND],'#g':indexed,limit:GEO_QUERY_LIMIT,...(this.authors?{authors:[...this.authors]}:{}),...(this.tags.length?{'#t':[...this.tags]}:{})}]);
    }
    for (const connection of this.connections.values()) if (!connection.failed && connection.socket?.readyState === 1) this.requestGeohashes(connection)
  }

  requestGeohashes(connection: RelayConnection) {
    try {
      for(const id of connection.geoSubscriptions??[])connection.socket.send(JSON.stringify(['CLOSE',id]));
      connection.geoSubscriptions=new Set();connection.geoSubscription = null
      if (!this.geohashes.length || !this.hasInventoryQuery) return
      const batches=geographicRequests(this.geohashes,{authors:this.authors,tags:this.tags});
      for(const filters of batches){
        connection.geoSubscription=`map-${++this.geoSequence}`;
        connection.geoSubscriptions.add(connection.geoSubscription);
        connection.socket.send(JSON.stringify(['REQ',connection.geoSubscription,...filters]));
      }
    } catch { connection.geoSubscription = null;connection.geoSubscriptions?.clear() }
  }

  refresh() {
    if (!this.running) return this.start()
    if (!this.hasQueries) { this.emitStatus(); this.emitChange(); return this }
    this.requestIndex()
    for (const url of this.relays) {
      const connection = this.connections.get(url)
      if (connection?.socket?.readyState === 1 && !connection.failed) { this.request(connection); this.requestGeohashes(connection) }
      else {
        if (connection) this.dispose(connection)
        this.connect(url)
      }
    }
    this.emitStatus()
    return this
  }

  close() {
    this.running = false
    this.cacheGeneration++
    this.queryController.abort()
    clearTimeout(this.tagSelectionTimer);this.tagSelectionTimer=null
    for(const controller of this.indexReads)controller.abort();this.indexReads.clear()
    for (const finish of [...this.historyReaders]) finish({ error: 'Loading stopped.' })
    clearInterval(this.expiryTimer)
    clearTimeout(this.changeTimer)
    this.expiryTimer = this.changeTimer = null
    for (const connection of this.connections.values()) this.dispose(connection)
    this.connections.clear()
    this.emitStatus()
  }

  connect(url, attempt = 0) {
    if (!this.running) return
    const connection: RelayConnection = { url, attempt, socket: null, failed: false, ready: false, subscription: `market-${Math.random().toString(36).slice(2, 14)}`, timer: null, retry: null, frameStart: Date.now(), frames: 0 }
    this.connections.set(url, connection)
    let socket
    try { socket = new this.WebSocket(url) }
    catch { this.failed(connection); return }
    connection.socket = socket
    const current = () => this.running && this.connections.get(url) === connection && !connection.failed
    connection.timer = setTimeout(() => { if (current()) this.failed(connection) }, 10000)
    socket.onopen = () => {
      if (!current()) return
      clearTimeout(connection.timer)
      connection.timer = null
      this.request(connection)
      this.requestGeohashes(connection)
      this.emitStatus()
    }
    socket.onmessage = ({ data }) => {
      if (!current() || typeof data !== 'string') return
      if (Date.now() - connection.frameStart > 10000) { connection.frames = 0; connection.frameStart = Date.now() }
      if (++connection.frames > 600 || data.length > MAX_FRAME_BYTES || bytes(data) > MAX_FRAME_BYTES) { this.failed(connection); return }
      let frame
      try { frame = JSON.parse(data) } catch { return }
      if (!Array.isArray(frame)) return
      if (connection.geoSubscriptions?.has(frame[1])) {
        // No EOSE/ACK gate: each valid event becomes visible as it arrives.
        if (frame[0] === 'CLOSED') { connection.geoSubscriptions.delete(frame[1]);if(frame[1]===connection.geoSubscription)connection.geoSubscription = null;return }
        if (frame[0] !== 'EVENT' || frame.length !== 3) return
        try {
          const listing = this.parseIncoming(frame[2])
          if (!this.matchesFeed(listing) || !frame[2].tags.some(tag => tag[0] === 'g' && this.geohashSet.has(tag[1]))) return
          this.acceptListing(listing)
        } catch { /* Ignore malformed or unrelated map results. */ }
        return
      }
      if (frame[1] !== connection.subscription) return
      if (frame[0] === 'EOSE') {
        connection.ready = true
        connection.attempt = 0
        clearTimeout(connection.timer)
        connection.timer = null
        this.emitStatus()
      } else if (frame[0] === 'CLOSED') {
        this.failed(connection)
      } else if (frame[0] === 'EVENT' && frame.length === 3) {
        try {
          const listing = this.parseIncoming(frame[2])
          const history = this.history.get(url)
          // The exact shared-target query may return an ancient event alongside
          // recent inventory. It must not skip the intervening history.
          if (!history.started && !connection.ready && listing.id !== this.targetId && this.matchesFeed(listing)) {
            history.initialOldest = Math.min(history.initialOldest ?? listing.createdAt, listing.createdAt)
          }
          this.acceptListing(listing)
        } catch { /* Untrusted malformed records never enter the visible store. */ }
      }
    }
    socket.onerror = () => { if (current()) this.failed(connection) }
    socket.onclose = () => { if (current()) this.failed(connection) }
    this.emitStatus()
  }

  acceptListing(listing: MarketListing) {
    // Preserve newer revisions of known coordinates even if their tags changed.
    if (listing.id !== this.targetId && !this.matchesFeed(listing) && !this.records.has(listing.id)) return
    if (this.seen.has(listing.eventId)) return
    this.seen.add(listing.eventId)
    if (this.seen.size > 4000) this.seen.delete(this.seen.values().next().value)
    const capacity = this.targetId && listing.id !== this.targetId && !this.records.has(this.targetId) ? this.maxRecords - 1 : this.maxRecords
    if (applyListing(this.records, listing, capacity)) this.scheduleChange()
  }

  pagination(): MarketPagination {
    const histories = [...this.history.values()]
    const exhausted = !this.hasInventoryQuery || (histories.length > 0 && histories.every(item => item.exhausted))
    const limited = this.records.size >= this.maxRecords || histories.some(item => item.limited)
    return {
      loading: this.pageLoading, exhausted, limited,
      hasMore: !exhausted && !limited && this.hasInventoryQuery,
      error: this.pageError, added: this.pageAdded, records: this.records.size,
    }
  }

  emitPagination() {
    const value = this.pagination(), fingerprint = JSON.stringify(value)
    if (fingerprint === this.lastPagination) return
    this.lastPagination = fingerprint
    this.onPagination(value)
  }

  /** Fetch a bounded older page per relay. Errors require an explicit retry. */
  loadOlder() {
    if (this.pagePromise) return this.pagePromise
    const current = this.pagination()
    if (current.exhausted || current.limited) return Promise.resolve(current)
    if (!this.running || !this.relays.length) {
      this.pageError = 'Connect to load more listings.'
      this.emitPagination()
      return Promise.resolve(this.pagination())
    }
    this.pageLoading = true
    this.pageError = ''
    this.pageAdded = 0
    const before = this.records.size
    this.pagePromise = Promise.resolve().then(async () => {
      const results = await Promise.all([...this.history].filter(([, item]) => !item.exhausted && !item.limited)
        .map(([url, item]) => this.loadOlderFrom(url, item)))
      if (results.some(result => result.error)) this.pageError = 'Couldn’t load all older listings. Try again.'
      this.pageAdded = Math.max(0, this.records.size - before)
    }).finally(() => {
      this.pageLoading = false
      this.pagePromise = null
      if (this.running) { this.emitChange(); this.emitPagination() }
    }).then(() => this.pagination())
    this.emitPagination()
    return this.pagePromise
  }

  async loadOlderFrom(url: string, history: RelayHistory, options:HistoryOptions={}): Promise<HistoryPage> {
    history.started = true
    history.cursor ??= history.initialOldest ?? this.now()
    let limit = options.pageSize??this.historyPageSize
    // At most four reads drain a dense second (300, 600, 1000) and
    // check the next second. Never silently skip an unfilled boundary.
    for (let round = 0; round < (options.rounds??4) && this.running&&!options.signal?.aborted; round++) {
      if (this.records.size >= this.maxRecords) return { limited: true }
      if (history.requests >= (options.maxRequests??MAX_HISTORY_REQUESTS)) { history.limited = true; return { limited: true } }
      if(options.requestBudget){if(options.requestBudget.count>=options.requestBudget.max){history.limited=true;return{limited:true}}options.requestBudget.count++}
      const until = history.cursor
      history.requests++
      const page = await this.readHistory(url, until, limit,options)
      if (page.error || page.limited) return page
      if (page.count === 0) { history.exhausted = true; return {} }
      if (page.oldest < until) { history.cursor = page.oldest; return {} }
      // A full page entirely in the boundary second cannot establish that
      // every event in that second arrived. Increase the limit, not the cursor.
      if (page.count >= limit) {
        if (limit >= this.maxRecords) { history.limited = true; return { limited: true } }
        limit = Math.min(this.maxRecords, limit * 2)
      } else {
        if (until === 0) { history.exhausted = true; return {} }
        history.cursor = until - 1
        limit = options.pageSize??this.historyPageSize
      }
    }
    return { error: this.running ? 'History boundary needs another request.' : 'Loading stopped.' }
  }

  readHistory(url: string, until: number, limit: number,options:HistoryOptions={}): Promise<HistoryPage> {
    return new Promise<HistoryPage>(resolve => {
      const subscription = `older-${Math.random().toString(36).slice(2, 14)}`
      let socket, ended = false, timer, frames = 0, receivedBytes = 0, invalid = false, oldest = null
      const accepted = new Set()
      const finish = (result: HistoryPage) => {
        if (ended) return
        ended = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort',abort)
        this.historyReaders.delete(finish)
        if (socket) {
          socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
          try { if (socket.readyState === 1) socket.send(JSON.stringify(['CLOSE', subscription])) } catch { /* Closed. */ }
          try { socket.close() } catch { /* Closed. */ }
        }
        resolve(result)
      }
      const abort=()=>finish({error:'Loading stopped.'})
      if(options.signal?.aborted){finish({error:'Loading stopped.'});return}
      options.signal?.addEventListener('abort',abort,{once:true})
      this.historyReaders.add(finish)
      timer = setTimeout(() => finish({ error: 'Older listings timed out.' }), options.timeoutMs??HISTORY_TIMEOUT)
      try { socket = new this.WebSocket(url) } catch { finish({ error: 'Connection failed.' }); return }
      socket.onopen = () => {
        if (ended || !this.running) { finish({ error: 'Loading stopped.' }); return }
        const filter: MarketFilter = { kinds: [LISTING_KIND], until, limit }
        if (this.authors !== null) filter.authors = this.authors
        const tags=options.tags??this.tags;if (tags.length) filter['#t'] = tags
        try { socket.send(JSON.stringify(['REQ', subscription, filter])) }
        catch { finish({ error: 'Request failed.' }) }
      }
      socket.onmessage = ({ data }) => {
        if (ended || typeof data !== 'string') return
        if (data.length > MAX_FRAME_BYTES) { finish({ error: 'Older response exceeded its limit.' }); return }
        const size = bytes(data)
        if(options.budget){options.budget.bytes+=size;if(options.budget.bytes>options.budget.max){finish({limited:true});return}}
        receivedBytes += size
        if (++frames > limit * 2 + 32 || size > MAX_FRAME_BYTES || receivedBytes > MAX_HISTORY_BYTES) { finish({ error: 'Older response exceeded its limit.' }); return }
        let frame
        try { frame = JSON.parse(data) } catch { invalid = true; return }
        if (!Array.isArray(frame) || frame[1] !== subscription) return
        if (frame[0] === 'CLOSED') { finish({ error: 'Older request was closed.' }); return }
        if (frame[0] === 'EOSE') {
          finish(invalid ? { error: 'Older response was incomplete.' } : { count: accepted.size, oldest })
          return
        }
        if (frame[0] !== 'EVENT' || frame.length !== 3) return
        try {
          const listing = this.parseIncoming(frame[2])
          const scoped=options.tags?(!this.authorSet||this.authorSet.has(listing.author))&&listing.tags.some(tag=>options.tags.includes(tag)):this.matchesFeed(listing)
          if (listing.createdAt > until || !scoped) { invalid = true; return }
          if (!accepted.has(listing.eventId) && accepted.size >= limit) { finish({ error: 'Older response exceeded its limit.' }); return }
          accepted.add(listing.eventId)
          oldest = Math.min(oldest ?? listing.createdAt, listing.createdAt)
          this.acceptListing(listing)
          if (this.records.size >= this.maxRecords) finish({ limited: true })
        } catch { invalid = true }
      }
      socket.onerror = () => finish({ error: 'Connection failed.' })
      socket.onclose = () => finish({ error: 'Connection closed.' })
    })
  }

  request(connection: RelayConnection) {
    connection.ready = false
    clearTimeout(connection.timer)
    try {
      const filters = []
      if (this.hasInventoryQuery) {
        const inventory: MarketFilter = { kinds: [LISTING_KIND], limit: 300 }
        if (this.authors !== null) inventory.authors = this.authors
        if (this.tags.length) inventory['#t'] = this.tags
        filters.push(inventory)
      }
      if (this.targetFilter) filters.push(this.targetFilter)
      if (!filters.length) return
      connection.socket.send(JSON.stringify(['REQ', connection.subscription, ...filters]))
      connection.timer = setTimeout(() => {
        if (this.running && this.connections.get(connection.url) === connection && !connection.ready) this.failed(connection)
      }, 15000)
    } catch { this.failed(connection) }
  }

  failed(connection: RelayConnection) {
    if (!this.running || this.connections.get(connection.url) !== connection || connection.failed) return
    connection.failed = true
    connection.ready = false
    clearTimeout(connection.timer)
    try { connection.socket?.close() } catch { /* Already closed. */ }
    const delay = Math.min(30000, 1000 * 2 ** Math.min(connection.attempt, 5))
    connection.retry = setTimeout(() => {
      if (this.running && this.connections.get(connection.url) === connection) this.connect(connection.url, connection.attempt + 1)
    }, delay)
    this.emitStatus()
  }

  dispose(connection: RelayConnection) {
    connection.failed = true
    clearTimeout(connection.timer)
    clearTimeout(connection.retry)
    try {
      if (connection.socket?.readyState === 1) connection.socket.send(JSON.stringify(['CLOSE', connection.subscription]))
      if(connection.socket?.readyState===1)for(const id of connection.geoSubscriptions??[])connection.socket.send(JSON.stringify(['CLOSE',id]));connection.geoSubscriptions?.clear()
      connection.socket?.close()
    } catch { /* Closing an already-closed socket is harmless. */ }
  }

  scheduleChange() {
    if (this.changeTimer !== null) return
    this.changeTimer = setTimeout(() => { this.changeTimer = null; if (this.running) this.emitChange() }, 24)
  }

  emitChange() {
    const listings = this.listings()
    const fingerprint = listings.map(item => item.eventId).join(',')
    if (fingerprint === this.lastVisible) return
    this.lastVisible = fingerprint
    this.onChange(listings)
  }

  emitStatus() {
    const contexts = [...this.connections.values()]
    const connected = contexts.filter(item => !item.failed && item.socket?.readyState === 1).length
    const ready = contexts.filter(item => !item.failed && item.ready).length
    const attempting = contexts.some(item => !item.failed)
    const state = !this.running ? 'closed' : !this.hasQueries ? 'empty' : ready ? 'live' : attempting ? 'connecting' : 'offline'
    const message = { closed: 'Disconnected', empty: 'No followed authors', live: 'Live listings', connecting: 'Connecting to listings', offline: 'Offline · keeping received listings' }[state]
    const value: MarketStatus = { state, connected, total: this.hasQueries ? this.relays.length : 0, message }
    const fingerprint = JSON.stringify(value)
    if (fingerprint === this.lastStatus) return
    this.lastStatus = fingerprint
    this.onStatus(value)
  }
}
