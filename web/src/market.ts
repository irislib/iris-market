import {BITCOIN_KIND,bitcoinFilter,readEscrowOffer} from './escrow-offer.ts';
import {keywordSearches,matchesLiteralSearch,listingSearchText} from './lexical-search.ts'
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure'
import { locationFromTags, MAX_GEOHASH_QUERY_VALUES, WEB_REGIONAL_QUERY_VALUES } from './map/geohash.ts'
import { exactListingPoint } from './map/listing-pin.ts'
import { getPublicRuntime, queryPublicIndex } from './nostr-runtime.ts'
import { createListingRecovery } from './listing-recovery.ts'
import type { Filter } from 'nostr-tools'
import { HistoryCursor, relaySource, SOURCE_PRIORITY_RELAY, type NostrVerifiedEvent, type RuntimeQueryOptions } from 'nostr-pubsub'
import { SeenTags, observedMarketTags, TAG_LIMITS, type SearchTagExpansion } from './seen-tags.ts'
import {publicListingCache,type PublicListingCache} from './offline-listings.ts'
import {parseServiceAreas} from './service-area.ts'

export const DEFAULT_RELAYS = Object.freeze(['wss://temp.iris.to', 'wss://vault.iris.to', 'wss://relay.damus.io', 'wss://relay.snort.social', 'wss://relay.primal.net', 'wss://nos.lol'])
export const LISTING_KIND = 30402
export const MAX_RECORDS = 1000
const MAX_EVENT_BYTES = 65536
const MAX_FRAME_BYTES = MAX_EVENT_BYTES + 2048
const SEARCH_RECORD_LIMIT = 5000
const BUYING_RESERVE = 120
const MAP_RECORD_RESERVE = 1000
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

// Other clients also use k for unrelated metadata. Only buy and sell set the side.
function classifiedSide(tags:string[][]):'offer'|'request' {
  const directions = new Set(tags.filter(([name,value])=>name==='k'&&(value==='buy'||value==='sell')).map(tag=>tag[1]));
  if (directions.size>1) fail('Conflicting listing directions')
  if (directions.size) return directions.has('buy')?'request':'offer'
  return tags.some(([name,value])=>name==='type'&&(value==='want_buy'||value==='want_rent'))?'request':'offer'
}

/** Verify and normalise a NIP-99 record. Sold/expired records are valid tombstones. */
export function parseEvent(input: NostrEvent, { now = seconds() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid listing event')
  if (input.kind !== LISTING_KIND && input.kind !== BITCOIN_KIND) fail('Not a classified listing')
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

  const quote=readEscrowOffer(event.kind,event.tags);
  const identifier = singleton(event, 'd')
  if (!identifier || bytes(identifier) > 160) fail('Invalid listing identifier')
  const title = singleton(event, 'title')
  if (typeof title !== 'string' || !title.trim() || length(title) > 160) fail('Invalid listing title')
  if (bytes(event.content) > 12000) fail('Description is too long')
  const side = quote.side ?? classifiedSide(event.tags)
  const location = singleton(event, 'location') ?? ''
  const geo = locationFromTags(event.tags)
  const exactPoint = exactListingPoint(event.tags, geo?.geohash ?? null)
  const tags = event.tags.filter(tag => tag[0] === 't' && typeof tag[1] === 'string' && !tag[1].startsWith('market:')).map(tag => tag[1])
  const category = tags[0] ?? 'Other'
  if (length(location) > 160 || length(category) > 60) fail('Location or category is too long')
  const price = quote.price ?? singleton(event, 'price') ?? ''
  const currency = quote.currency ?? event.tags.find(tag => tag[0] === 'price')?.[2] ?? 'EUR'
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
  if(quote.expiration!=null)expiration=Math.min(quote.expiration,expiration??Infinity);
  const status = quote.status ?? singleton(event, 'status') ?? 'active'
  if (status !== 'active' && status !== 'sold') fail('Invalid listing status')
  const originalTags = Object.freeze(event.tags.map(tag => Object.freeze([...tag])))
  // Preserve the verification brand on this defensive, immutable wire copy.
  const rawEvent = Object.freeze({ ...event, tags: originalTags })
  return Object.freeze({
    rawEvent, escrow:quote.escrow, id: (event.kind===BITCOIN_KIND?"38383:":"")+`${event.pubkey}:${identifier}`, eventId: event.id, author: event.pubkey,
    identifier, title, description: event.content, price, currency, location,
    geohash: geo?.geohash ?? null, coordinates: exactPoint ? Object.freeze(exactPoint) : geo?.coordinates ?? null, locationBounds: geo?.bounds ?? null,
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
  const kind=typeof targetId==='string' && targetId.startsWith('38383:')?BITCOIN_KIND:LISTING_KIND;
  if(kind===BITCOIN_KIND)targetId=targetId.slice(6);
  if (typeof targetId !== 'string' || targetId[64] !== ':' || !hex(targetId.slice(0, 64), 64)) fail('Invalid listing link')
  const identifier = targetId.slice(65)
  if (!identifier || bytes(identifier) > 160) fail('Invalid listing link')
  const exact = {kinds:[kind],authors:[targetId.slice(0,64)],'#d':[identifier],limit:1}
  return kind===BITCOIN_KIND ? bitcoinFilter(exact) : exact
}

export type MarketListing = ReturnType<typeof parseEvent>
export interface MarketFilter {
  kinds: number[]
  authors?: readonly string[]
  '#y'?: string[]
  '#d'?: string[]
  '#t'?: readonly string[]
  '#g'?: string[]
  until?: number
  search?: string
  limit: number
}
export interface MarketPagination { loading: boolean; exhausted: boolean; limited: boolean; hasMore: boolean; error: string; added: number; records: number }
export interface MarketStatus { state: 'closed' | 'empty' | 'live' | 'connecting' | 'offline'; connected: number; total: number; message: string }
interface RelayHistory { initialOldest: number | null; cursor: number | null; started: boolean; exhausted: boolean; limited: boolean; requests: number; answered?:boolean; rankedLimit?:number; pager?: HistoryCursor }
interface HistoryPage { error?: string; limited?: boolean; count?: number; oldest?: number | null }
interface HistoryOptions {bitcoin?:boolean;search?:string; tags?:readonly string[];signal?:AbortSignal;pageSize?:number;maxRequests?:number;rounds?:number;timeoutMs?:number;budget?:{bytes:number;max:number};requestBudget?:{count:number;max:number};observe?:(event:NostrVerifiedEvent)=>void }
interface QueryTagPlan {search?:string;tags:readonly string[];history:Map<string,RelayHistory>;indexHistory:RelayHistory}
export interface QueryCandidates {answered:boolean;loading:boolean;added:number;hasMore:boolean;error:string;limited:boolean}
interface RelayConnection {
  url: string; attempt: number; socket: WebSocket | null; failed: boolean; ready: boolean; subscription: string
  initialOldest?: number | null
  buyingId?:string
  bitcoinOldest?: number | null
  timer: ReturnType<typeof setTimeout> | null; retry: ReturnType<typeof setTimeout> | null
  frameStart: number; frames: number; geoSubscriptions?: Set<string>; geoNext?:number; geoTimer?:ReturnType<typeof setTimeout>
}
export interface MarketRelayOptions {
  mapRelay?: string; relays?: readonly string[]; tags?: readonly string[]; authors?: readonly string[] | null; targetId?: string
  onChange?: (listings: MarketListing[]) => void; onStatus?: (status: MarketStatus) => void; onPagination?: (pagination: MarketPagination) => void
  historyPageSize?: number; records?: Map<string, MarketListing>; maxRecords?: number; browseDiscovery?:boolean
  WebSocketImpl?: typeof WebSocket; now?: () => number
  indexSearch?: boolean
  indexQuery?: ((filters:Filter[],options:RuntimeQueryOptions)=>Promise<{events:NostrEvent[];complete?:boolean}>) | null
  tagCatalogue?: SeenTags
  offlineCache?: PublicListingCache | null
}

/** Complete precision covers, split below common relay frame/subscription limits. */
export function geographicRequests(values:readonly string[],{authors=null,tags=[]}:{authors?:readonly string[]|null;tags?:readonly string[]}={}):MarketFilter[][] {
  const regional=values.length>MAX_GEOHASH_QUERY_VALUES;
  const groups=new Map<number,string[]>();
  for(const hash of values){if(!groups.has(hash.length))groups.set(hash.length,[]);groups.get(hash.length).push(hash);}
  let selected:string[][]=[],accepted:MarketFilter[][]=[];
  for(const [,cover] of [...groups].sort(([a],[b])=>a-b)){
    const candidate=[...selected];for(let start=0;start<cover.length;start+=512)candidate.push(cover.slice(start,start+512));
    const limit=Math.min(GEO_QUERY_LIMIT,Math.floor((regional?480:240)/candidate.length));
    const filters:MarketFilter[]=candidate.map(cells=>({kinds:[LISTING_KIND],'#g':cells,limit,...(authors!==null?{authors}:{}),...(tags.length?{'#t':tags}:{})}));
    const batches:MarketFilter[][]=[];let batch:MarketFilter[]=[];
    for(const filter of filters){
      if(batch.length&&(batch.length===8||bytes(JSON.stringify(['REQ','map-0000000000000000',...batch,filter]))>28*1024)){batches.push(batch);batch=[];}
      batch.push(filter);
    }
    if(batch.length)batches.push(batch);
    // Never trim a fine cover to its western/first cells: keep the preceding
    // whole covers when an audience or long tags consume the frame budget.
    if(batches.length>(regional?18:9)||batches.some(value=>bytes(JSON.stringify(['REQ','map-0000000000000000',...value]))>28*1024))break;
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
  private browseDiscovery:boolean
  private inventoryCapacity:number
  private buyingCategory='all'
  private buying=false
  private buyingOverflow=0
  private mapOverflow=0
  onChange: NonNullable<MarketRelayOptions['onChange']>
  onStatus: NonNullable<MarketRelayOptions['onStatus']>
  onPagination: NonNullable<MarketRelayOptions['onPagination']>
  historyPageSize: number
  history: Map<string, RelayHistory>
  bitcoinHistory = new Map<string, RelayHistory>()
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
  changeTimer: ReturnType<typeof setTimeout> | null
  expiryTimer: ReturnType<typeof setInterval> | null
  lastVisible: string | null
  lastStatus: string
  geohashes: string[]
  geohashSet = new Set<string>()
  private observedCells: string[] = []
  private mapRelay?: string
  private geoBatches:MarketFilter[][]=[]
  geoSequence: number
  indexSearch:boolean
  indexQuery: MarketRelayOptions['indexQuery']
  indexReads = new Set<AbortController>()
  indexRequests = 0
  indexBytes = 0
  tagCatalogue: SeenTags
  queryTags:readonly string[]=[]
  queryPlans:QueryTagPlan[]=[]
  queryExtraTerms:readonly string[]=[]
  queryExtraTags:readonly string[]=[]
  queryRequestBudget={count:0,max:32}
  queryController=new AbortController()
  queryPromise:Promise<QueryCandidates>|null=null
  queryBudget={bytes:0,max:8*1024*1024}
  queryAdded=0
  queryError=''
  queryText=''
  queryExpansion:SearchTagExpansion='literal'
  tagSelectionTimer:ReturnType<typeof setTimeout>|null=null
  offlineCache:PublicListingCache|null
  cacheGeneration=0
  recovery:ReturnType<typeof createListingRecovery>|null=null
  recoveryEnabled:boolean
  constructor({ relays = DEFAULT_RELAYS, mapRelay, onChange = () => {}, onStatus = () => {}, onPagination = () => {}, historyPageSize = HISTORY_PAGE_SIZE, records = new Map(), maxRecords = MAX_RECORDS, browseDiscovery=false, WebSocketImpl, now = seconds, targetId, tags = [], authors = null, indexQuery, indexSearch=false, tagCatalogue=observedMarketTags,offlineCache }: MarketRelayOptions = {}) {
    this.relays = validateRelays(relays)
    const extra = mapRelay && validateRelays([mapRelay])[0]
    if (extra && !this.relays.includes(extra)) this.mapRelay = extra
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
    this.inventoryCapacity=maxRecords
    this.browseDiscovery=browseDiscovery
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
    this.recoveryEnabled=!WebSocketImpl&&typeof globalThis.Worker==='function'
    this.indexSearch=indexSearch
    this.indexQuery = indexQuery===undefined ? (WebSocketImpl ? null : (filters,options)=>queryPublicIndex(this.relays,filters,options)) : indexQuery
    this.tagCatalogue=tagCatalogue
    this.offlineCache=offlineCache===undefined?(WebSocketImpl?null:publicListingCache(event=>parseEvent(event))):offlineCache
    this.now = now
    this.running = false
    this.connections = new Map()
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
    if(this.hasInventoryQuery&&this.recoveryEnabled){
      this.recovery=createListingRecovery({runtime:getPublicRuntime(this.relays),
        readCache:async()=>this.offlineCache?(this.offlineCache.loadForRecovery?.()??this.offlineCache.load()):[],
        readMemory:()=>[...this.records.values()].map(listing=>listing.rawEvent) as NostrEvent[],
        now:()=>this.now()*1000,
        onEvent:event=>{if(this.running)try{this.acceptListing(this.parseIncoming(event));}catch{/* Invalid or obsolete records stay hidden. */}},
      })
      const filter = {kinds:[LISTING_KIND],...(this.authors?{authors:[...this.authors]}:{}),...(this.tags.length?{'#t':[...this.tags]}:{})}
      void this.recovery.recover(filter)
      void this.recovery.recover(bitcoinFilter(filter))
    }
    void this.restoreOffline(++this.cacheGeneration)
    if (this.hasQueries) for (const url of this.activeRelays()) this.connect(url)
    this.requestIndex()
    if (this.buying) this.requestIndex(this.buyingFilters(),false)
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
    this.recovery?.observe(event)
    if(this.running&&this.queryExpansion==='expanded'&&this.queryText&&this.queryTags.length<TAG_LIMITS.queryTags&&this.tagSelectionTimer===null)this.tagSelectionTimer=setTimeout(()=>{
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

  /** Literal retrieval is the default; only AI mode opts into observed/model expansions. */
  searchTags(query:string,extraTags?:readonly string[],expansion:SearchTagExpansion=this.queryExpansion,extraTerms?:readonly string[]):readonly string[] {
    const text=typeof query==='string'&&query.length<=TAG_LIMITS.queryChars?query:'',policy=expansion==='expanded'?'expanded':'literal'
    const changed=text!==this.queryText||policy!==this.queryExpansion
    if(changed){
      this.queryExtraTerms=[];this.queryExtraTags=[]
      if(this.tagSelectionTimer!==null){clearTimeout(this.tagSelectionTimer);this.tagSelectionTimer=null}
    }
    this.queryText=text;this.queryExpansion=policy
    if(changed)this.openSearchPage()
    if(policy==='literal')this.queryExtraTags=[]
    else if(extraTags!==undefined)this.queryExtraTags=Array.isArray(extraTags)?extraTags.slice(0,TAG_LIMITS.queryTags).filter(tag=>typeof tag==='string'&&tag.length<=60):[]
    const proposed=policy==='expanded'?this.tagCatalogue.select(text,TAG_LIMITS.queryTags,this.queryExtraTags):changed?this.tagCatalogue.selectLiteral(text):this.queryTags
    // New observations may fill AI slots without reshuffling its cursor or
    // replenishing finite budgets. Literal spelling variants are frozen at submission.
    const selected=policy==='expanded'&&!changed&&extraTags===undefined?[...new Set([...this.queryTags,...proposed])].slice(0,TAG_LIMITS.queryTags):proposed
    if(policy==='expanded'&&extraTerms!==undefined)
      this.queryExtraTerms=extraTerms.filter(term=>typeof term==='string'&&term.length<=60&&/^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)?$/u.test(term)).slice(0,2)
    return this.applyQueryTags(selected,changed)
  }

  setQueryTags(tags:readonly string[]):readonly string[] {
    const selected=feedTags(tags).filter(tag=>this.tagCatalogue.has(tag))
    this.queryText='';this.queryExtraTags=[];this.queryExtraTerms=[];this.queryExpansion='literal'
    if(this.tagSelectionTimer!==null){clearTimeout(this.tagSelectionTimer);this.tagSelectionTimer=null}
    return this.applyQueryTags(selected,true)
  }

  private applyQueryTags(tags:readonly string[],reset:boolean):readonly string[] {
    const selected=feedTags(tags)
    const searches=[...new Set([...keywordSearches(this.queryText),...this.queryExtraTerms])]
    const unchanged=JSON.stringify(selected)===JSON.stringify(this.queryTags)&&JSON.stringify(searches)===JSON.stringify(this.queryPlans.filter(p=>p.search).map(p=>p.search))
    if(!reset&&unchanged)return this.queryTags
    // A cold topic plan can finish before the first relay sockets open. Let
    // those reads finish and keep their spent request budget and cursors.
    if(reset||!this.queryExtraTerms.length){this.queryController.abort();this.queryController=new AbortController();this.queryPromise=null}
    this.queryTags=Object.freeze(selected);this.queryAdded=0;this.queryError=''
    if(reset){this.queryBudget={bytes:0,max:8*1024*1024};this.queryRequestBudget={count:0,max:32}}
    const previous=reset?[]:this.queryPlans,newHistory=():RelayHistory=>({initialOldest:null,cursor:null,started:false,exhausted:false,limited:false,requests:0})
    // Give the direct phrase its own response limit. A broad related tag must
    // not crowd exact matches out of a combined OR query.
    this.queryPlans=[selected.slice(0,1),selected.slice(1)].filter(group=>group.length).map(group=>previous.find(plan=>JSON.stringify(plan.tags)===JSON.stringify(group))??{
      tags:Object.freeze(group),history:new Map(this.relays.map(url=>[url,newHistory()])),indexHistory:{...newHistory(),exhausted:!this.indexQuery},
    })
    const groups=Math.min(this.relays.length,searches.length-1)
    const connected=this.relays.filter(url=>this.connections.get(url)?.socket?.readyState===1)
    const refinementRelays=[...new Set([...connected,...this.relays])].slice(0,2)
    for(const [index,search] of searches.entries()){
      const existing=previous.find(plan=>plan.search===search)
      if(existing){this.queryPlans.push(existing);continue}
      // Distribute alternate filters, including when there are more words than
      // relays. The exact query keeps all relays and every plan shares one budget.
      const endpoints=this.queryExtraTerms.includes(search)?refinementRelays:
        this.relays.filter((_,relay)=>index===0||relay%groups===(index-1)%groups)
      this.queryPlans.push({search,tags:[],history:new Map(endpoints.map(url=>[url,newHistory()])),
        indexHistory:{...newHistory(),exhausted:!this.indexQuery||!this.indexSearch}})
    }
    if(this.running&&this.queryPlans.length)void this.loadQueryCandidates()
    return this.queryTags
  }

  private get inventoryFull(){return this.records.size>=this.inventoryCapacity+this.mapOverflow+this.buyingOverflow}
  get mapDiscoveryLimited(){return this.inventoryFull&&(!this.browseDiscovery||this.mapOverflow>=MAP_RECORD_RESERVE)}
  openSearchPage(){
    if(this.browseDiscovery&&this.queryText&&this.inventoryFull)
      this.inventoryCapacity=Math.min(SEARCH_RECORD_LIMIT,this.inventoryCapacity+HISTORY_PAGE_SIZE)
  }

  loadMoreSearchResults() {
    this.openSearchPage()
    const current = this.queryPagination()
    // Retry keyword sources as well as tags, including sources which timed out on the first pass.
    if (!current.loading && (current.error || this.pageError)) this.applyQueryTags(this.queryTags,true)
    return Promise.all([this.loadQueryCandidates(),this.loadOlder()])
  }

  queryPagination():QueryCandidates {
    const histories=this.queryPlans.flatMap(plan=>[...plan.history.values(),plan.indexHistory])
    const full=this.inventoryFull||this.queryBudget.bytes>=this.queryBudget.max||this.queryRequestBudget.count>=this.queryRequestBudget.max
    const limited=full||histories.some(item=>item.limited)
    return{answered:histories.some(item=>item.answered),loading:!!this.queryPromise,added:this.queryAdded,error:this.queryError,limited,
      hasMore:!!this.queryPlans.length&&this.hasInventoryQuery&&!full&&histories.some(item=>!item.exhausted&&!item.limited)}
  }

  /** Finite independent tag and optional ranked-keyword discovery. The caller chooses how many batches to autoload. */
  loadQueryCandidates():Promise<QueryCandidates> {
    if(this.queryPromise)return this.queryPromise
    if(!this.running||!this.queryPagination().hasMore)return Promise.resolve(this.queryPagination())
    const plans=this.queryPlans,controller=this.queryController,budget=this.queryBudget,requestBudget=this.queryRequestBudget,before=this.records.size
    const options:HistoryOptions={signal:controller.signal,pageSize:80,maxRequests:8,rounds:2,timeoutMs:3500,budget,requestBudget}
    this.queryError='';this.queryAdded=0
    this.queryPromise=Promise.resolve().then(async()=>{
      // Round robin across plan types and endpoints before spending a second
      // request on any one plan. Keywords cannot crowd out tag sources.
      // Try newly selected terms before spending another read on an existing
      // history cursor. All sources still share the per-query cap.
      const order=[...plans].sort((a,b)=>Number(this.queryExtraTerms.includes(b.search))-Number(this.queryExtraTerms.includes(a.search)))
      const groups=order.map(({tags,search,history,indexHistory})=>[
        ...[...history].filter(([,item])=>!item.exhausted&&!item.limited).map(([url,item])=>()=>search?this.loadKeywordRelay(url,item,search,options):this.loadOlderFrom(url,item,{...options,tags})),
        ...(this.indexQuery&&!indexHistory.exhausted&&!indexHistory.limited?[()=>this.loadQueryIndex(tags,indexHistory,controller.signal,budget,requestBudget,search)]:[]),
      ])
      const requests=[]
      for(let round=0;groups.some(group=>round<group.length);round++)for(const group of groups)if(group[round])requests.push(group[round]())
      const results=await Promise.all(requests)
      if(controller!==this.queryController)return
      this.queryAdded=Math.max(0,this.records.size-before)
      if(results.some(result=>result.error))this.queryError='Some matching listings could not be loaded.'
    }).catch(()=>{if(controller===this.queryController)this.queryError='Matching listings could not be loaded.'}).finally(()=>{
      if(controller===this.queryController){
        this.queryPromise=null
        if(this.running){
          if(plans!==this.queryPlans)void this.loadQueryCandidates()
          this.emitChange();this.onPagination(this.pagination())
        }
      }
    }).then(()=>this.queryPagination())
    return this.queryPromise
  }

  async loadQueryIndex(tags:readonly string[],history:RelayHistory,signal:AbortSignal,budget:{bytes:number;max:number},requestBudget:{count:number;max:number},search?:string):Promise<HistoryPage> {
    if(requestBudget.count>=requestBudget.max){history.limited=true;return{limited:true}}
    requestBudget.count++
    if(++history.requests>4){history.limited=true;return{limited:true}}
    const until=history.cursor??this.now(),limit=search?(history.rankedLimit??120):120
    let timer:ReturnType<typeof setTimeout>,abort:()=>void
    try{
      const timeout=new Promise<never>((_,reject)=>{
        abort=()=>reject(new Error('Loading stopped.'));timer=setTimeout(()=>reject(new Error('Matching index read timed out.')),3500)
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
      })
      const report=await Promise.race([this.indexQuery([{kinds:[LISTING_KIND],...(search?{search}:{'#t':[...tags],until}),limit,...(this.authors?{authors:[...this.authors]}:{})}],{signal,deadline:Date.now()+3500,limit}),timeout])
      if(signal.aborted||!this.running)return{error:'Loading stopped.'}
      let oldest:number|null=null,count=0
      const seen=new Set<string>()
      for(const event of report.events.slice(0,limit)){
        budget.bytes+=bytes(JSON.stringify(event));if(budget.bytes>budget.max){history.limited=true;return{limited:true}}
        try{const listing=this.parseIncoming(event)
          if((!search&&listing.createdAt>until)||!(search?matchesLiteralSearch(listingSearchText(listing),search):listing.tags.some(tag=>tags.includes(tag)))||(this.authorSet&&!this.authorSet.has(listing.author)))continue
          if(seen.has(listing.eventId))continue
          seen.add(listing.eventId);oldest=Math.min(oldest??listing.createdAt,listing.createdAt);count++;this.acceptListing(listing)
        }catch{/* Invalid index records are not candidates. */}
      }
      if(count)history.answered=true;
      if(search){this.finishRankedPage(history,limit,count);return{}}
      if(oldest!==null&&oldest<until)history.cursor=oldest
      else if(count>=limit){history.limited=true;return{limited:true}}
      else if(report.complete){if(count)history.cursor=Math.max(0,until-1);else history.exhausted=true}
      else return{error:'Index history is incomplete.'}
      return{}
    }catch{if(search){if(!signal.aborted)history.exhausted=true;return{}}return{error:'Index history is unavailable.'}}
    finally{clearTimeout(timer);signal.removeEventListener('abort',abort)}
  }

  /** The same verified winner reducer receives durable history and live relay events. */
  requestIndex(extra:Filter[]=[],addBitcoin=true):void {
    if(!this.running||!this.hasQueries||!this.indexQuery||this.indexReads.size>=2||this.indexRequests>=16||this.indexBytes>=MAX_HISTORY_BYTES)return
    const filters:Filter[]=extra.length?extra:[
      ...(this.hasInventoryQuery?[{kinds:[LISTING_KIND],limit:this.historyPageSize,...(this.authors?{authors:[...this.authors]}:{}),...(this.tags.length?{'#t':[...this.tags]}:{})}]:[]),
      ...(this.targetFilter?[{kinds:this.targetFilter.kinds,authors:[...this.targetFilter.authors!],'#d':this.targetFilter['#d'],...(this.targetFilter['#y']?{'#y':this.targetFilter['#y']}:{}),limit:1}]:[]),
    ]
    if(addBitcoin) for(const filter of [...filters]) {
      if(filter.kinds?.length===1 && filter.kinds[0]===LISTING_KIND && !filter['#d'])filters.push(bitcoinFilter({...filter,kinds:[LISTING_KIND]}));
    }
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

  private buyingFilters():Filter[] {
    const scope = this.authors === null ? {} : {authors:[...this.authors]}
    // Relays combine #k and #t with AND. Tags within #t are alternatives.
    const topics = this.buyingCategory==='all' ? this.tags : [this.buyingCategory]
    const filter = {kinds:[LISTING_KIND],'#k':['buy'],...(topics.length?{'#t':[...topics]}:{}),limit:BUYING_RESERVE,...scope}
    return [filter,bitcoinFilter(filter)]
  }

  setBuying(active:boolean,category='all') {
    if (!this.browseDiscovery || !this.hasInventoryQuery || this.buying === active && (!active || this.buyingCategory === category)) return
    this.buyingCategory = category
    this.buying = active
    if (!this.running) return
    if (active) this.requestIndex(this.buyingFilters(),false)
    for (const connection of this.connections.values()) this.requestBuying(connection)
  }

  // Isolate older buy requests from the general feed's chronological cursor.
  private requestBuying(connection:RelayConnection) {
    if (connection.url === this.mapRelay) return
    if (connection.failed || connection.socket?.readyState !== 1) return
    if (connection.buyingId) {
      connection.socket.send(JSON.stringify(['CLOSE',connection.buyingId]))
      connection.buyingId = undefined
    }
    if (this.buying) {
      connection.buyingId = `buy-${Math.random().toString(36).slice(2,14)}`
      connection.socket.send(JSON.stringify(['REQ',connection.buyingId,...this.buyingFilters()]))
    }
  }

  /** Update only the map discovery subscription; received listings stay usable. */
  setGeohashes(values: string[] = [], observed: string[] = []) {
    if (!Array.isArray(values) || values.length > WEB_REGIONAL_QUERY_VALUES || values.some(value => typeof value !== 'string' || !/^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/.test(value))) fail('Invalid map search area')
    if (!Array.isArray(observed) || observed.length > 4096 || observed.some(cell => typeof cell !== 'string' || !/^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/i.test(cell))) fail('Invalid observed map cells')
    const next = [...new Set(values)].sort()
    const priority = next.length ? [...new Set(observed)].sort() : []
    if (JSON.stringify(next) === JSON.stringify(this.geohashes) && JSON.stringify(priority) === JSON.stringify(this.observedCells)) return
    this.geohashes = next
    this.observedCells = priority
    this.geohashSet = new Set([...next, ...priority])
    this.geoBatches=this.hasInventoryQuery?geographicRequests(next,{authors:this.authors,tags:this.tags}):[]
    if (this.hasInventoryQuery && priority.length) {
      // A dense four-character cover can have a limit of only a few events per filter.
      // Give known locations their own budget, including long tags with no published parent.
      const exact: MarketFilter[][] = []
      const limit = Math.min(GEO_QUERY_LIMIT, Math.floor(240 / Math.ceil(priority.length / 256)))
      for (let i = 0; i < priority.length; i += 256) {
        exact.push([{kinds:[LISTING_KIND], '#g':priority.slice(i,i+256), limit,
          ...(this.authors ? {authors:this.authors} : {}), ...(this.tags.length ? {'#t':this.tags} : {})}])
      }
      this.geoBatches.unshift(...exact)
    }
    if (!this.running) return
    if (this.mapRelay) {
      const connection = this.connections.get(this.mapRelay)
      if (this.geoBatches.length && !connection) this.connect(this.mapRelay)
      else if (!this.geoBatches.length && connection) {
        this.dispose(connection)
        this.connections.delete(this.mapRelay)
      }
    }
    if(next.length&&this.hasInventoryQuery){
      // Keep complete precision covers in the index's smaller query budget.
      const indexed:string[]=priority.slice(0,2048);
      for(const precision of [...new Set(next.map(value=>value.length))].sort((a,b)=>a-b)){
        const cover=next.filter(value=>value.length===precision);if(indexed.length+cover.length>2048)break;indexed.push(...cover);
      }
      this.requestIndex([{kinds:[LISTING_KIND],'#g':indexed,limit:GEO_QUERY_LIMIT,...(this.authors?{authors:[...this.authors]}:{}),...(this.tags.length?{'#t':[...this.tags]}:{})}]);
    }
    for (const connection of this.connections.values()) if (!connection.failed && connection.socket?.readyState === 1) this.requestGeohashes(connection)
  }

  requestGeohashes(connection: RelayConnection) {
    clearTimeout(connection.geoTimer)
    try {
      for(const id of connection.geoSubscriptions??[])connection.socket.send(JSON.stringify(['CLOSE',id]))
      connection.geoSubscriptions=new Set();connection.geoNext=0
      this.sendGeoBatches(connection)
    }catch{connection.geoSubscriptions?.clear()}
  }

  private sendGeoBatches(connection:RelayConnection){
    const active=connection.geoSubscriptions
    clearTimeout(connection.geoTimer)
    while(active.size<9&&connection.geoNext<this.geoBatches.length){
      const id=`map-${++this.geoSequence}`
      connection.socket.send(JSON.stringify(['REQ',id,...this.geoBatches[connection.geoNext++]]))
      active.add(id)
    }
    if(connection.geoNext<this.geoBatches.length){
      const oldest=active.values().next().value
      connection.geoTimer=setTimeout(()=>this.finishGeoBatch(connection,oldest,false),3500)
    }
  }

  private finishGeoBatch(connection:RelayConnection,id:string,closed:boolean){
    if(!connection.geoSubscriptions?.has(id)||!closed&&connection.geoNext>=this.geoBatches.length)return
    connection.geoSubscriptions.delete(id)
    try{
      if(!closed)connection.socket.send(JSON.stringify(['CLOSE',id]))
      this.sendGeoBatches(connection)
    }catch{clearTimeout(connection.geoTimer)}
  }

  private activeRelays() {
    return this.mapRelay && this.geoBatches.length ? [...this.relays, this.mapRelay] : this.relays
  }

  refresh() {
    if (!this.running) return this.start()
    if (!this.hasQueries) { this.emitStatus(); this.emitChange(); return this }
    this.requestIndex()
    for (const url of this.activeRelays()) {
      const connection = this.connections.get(url)
      if (connection?.socket?.readyState === 1 && !connection.failed) { this.request(connection); this.requestBuying(connection); this.requestGeohashes(connection) }
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
    this.recovery?.close();this.recovery=null
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
      this.requestBuying(connection)
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
      if (connection.buyingId && frame[1] === connection.buyingId) {
        if (frame[0] === 'EVENT' && frame.length === 3) {
          try {
            const listing = this.parseIncoming(frame[2])
            if (listing.side === 'request' || this.records.has(listing.id)) this.acceptListing(listing)
          } catch { /* Invalid requests never enter the feed. */ }
        }
        return
      }
      if (connection.geoSubscriptions?.has(frame[1])) {
        // No EOSE/ACK gate: each valid event becomes visible as it arrives.
        if(frame[0]==='EOSE'||frame[0]==='CLOSED'){this.finishGeoBatch(connection,frame[1],frame[0]==='CLOSED');return}
        if (frame[0] !== 'EVENT' || frame.length !== 3) return
        try {
          const listing = this.parseIncoming(frame[2])
          if (!this.matchesFeed(listing) || !frame[2].tags.some(tag => tag[0] === 'g' && this.geohashSet.has(tag[1]))) return
          this.acceptListing(listing)
        } catch { /* Ignore malformed or unrelated map results. */ }
        return
      }
      if (connection.url === this.mapRelay || frame[1] !== connection.subscription) return
      if (frame[0] === 'EOSE') {
        const history = this.history.get(url)
        // Display partial inventory immediately, but only a completed initial
        // page establishes where older history may safely start.
        if (history && !history.started) history.initialOldest = connection.initialOldest ?? null
        const bitcoin = this.bitcoinHistory.get(url)
        if (bitcoin && !bitcoin.started) bitcoin.initialOldest = connection.bitcoinOldest ?? null
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
          const bitcoin = listing.rawEvent.kind === BITCOIN_KIND
          if (bitcoin && listing.id !== this.targetId && !this.bitcoinHistory.has(url)) {
            this.bitcoinHistory.set(url, {initialOldest:null,cursor:null,started:false,exhausted:false,limited:false,requests:0})
          }
          const history = (bitcoin ? this.bitcoinHistory : this.history).get(url)
          // The exact shared-target query may return an ancient event alongside
          // recent inventory. It must not skip the intervening history.
          if (history && !history.started && !connection.ready && listing.id !== this.targetId && this.matchesFeed(listing)) {
            const field = bitcoin ? 'bitcoinOldest' : 'initialOldest'
            connection[field] = Math.min(connection[field] ?? listing.createdAt, listing.createdAt)
          }
          this.acceptListing(listing)
        } catch { /* Untrusted malformed records never enter the visible store. */ }
      }
    }
    socket.onerror = () => { if (current()) this.failed(connection) }
    socket.onclose = () => { if (current()) this.failed(connection) }
    this.emitStatus()
  }

  acceptListing(listing: MarketListing, publishedLocally=false) {
    // Preserve newer revisions of known coordinates even if their tags changed.
    if (!publishedLocally && listing.id !== this.targetId && !this.matchesFeed(listing) && !this.records.has(listing.id)) return
    // Keep the shared-listing slot and geographic discovery independent of a full general feed.
    const reserved=this.targetId&&listing.id!==this.targetId&&!this.records.has(this.targetId)?1:0
    let capacity=this.inventoryCapacity+this.mapOverflow+this.buyingOverflow-reserved
    if(!this.records.has(listing.id)&&this.records.size>=capacity){
      if (this.buying && listing.side==='request' && this.buyingOverflow<BUYING_RESERVE) this.buyingOverflow++
      else if (this.browseDiscovery && this.mapOverflow<MAP_RECORD_RESERVE && this.geohashSet.size &&
        listing.originalTags.some(tag=>tag[0]==='g'&&this.geohashSet.has(tag[1]))) this.mapOverflow++
      else return
      capacity++
    }
    if (applyListing(this.records, listing, capacity)) this.scheduleChange()
  }

  pagination(): MarketPagination {
    const histories = [...this.history.values(), ...this.bitcoinHistory.values()]
    const exhausted = !this.hasInventoryQuery || (histories.length > 0 && histories.every(item => item.exhausted))
    const limited = this.inventoryFull || (!exhausted && histories.length > 0 && histories.every(item => item.limited || item.exhausted))
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
      const reads = (histories:Map<string,RelayHistory>, bitcoin:boolean) => [...histories]
        .filter(([, item]) => !item.exhausted && !item.limited)
        .map(([url, item]) => this.loadOlderFrom(url, item, {bitcoin}))
      const results = await Promise.all([...reads(this.history,false),...reads(this.bitcoinHistory,true)])
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

  private finishRankedPage(history:RelayHistory,limit:number,count:number){
    // Ranked sources have no chronological cursor. Widen a full prefix while
    // signed candidates keep arriving, within the existing shared query budget.
    if(this.browseDiscovery&&this.queryExpansion==='expanded'&&count===limit){
      if(limit<320)history.rankedLimit=Math.min(320,limit*2)
      else history.limited=true
    }else history.exhausted=true
  }

  private async loadKeywordRelay(url:string,history:RelayHistory,search:string,options:HistoryOptions):Promise<HistoryPage> {
    if(options.requestBudget.count>=options.requestBudget.max){history.limited=true;return{limited:true}}
    options.requestBudget.count++;history.started=true;history.requests++
    const limit=history.rankedLimit??80
    const page=await this.readHistory(url,this.now(),limit,{...options,search,tags:[]})
    if(!options.signal.aborted&&!page.error&&!page.limited)history.answered=true
    if(!options.signal.aborted&&!page.limited)this.finishRankedPage(history,limit,page.count??0)
    return page.limited?{limited:true}:{}
  }

  async loadOlderFrom(url: string, history: RelayHistory, options:HistoryOptions={}): Promise<HistoryPage> {
    history.started = true
    history.cursor ??= history.initialOldest ?? this.now()
    if (!history.pager) {
      const tags = options.tags ?? this.tags
      history.pager = new HistoryCursor(url, {
        kinds: [options.bitcoin ? BITCOIN_KIND : LISTING_KIND], ...(options.bitcoin ? {'#y':['iris-market']} : {}), until: history.cursor,
        limit: Math.min(options.pageSize ?? this.historyPageSize, this.maxRecords),
        ...(this.authors !== null ? {authors: [...this.authors]} : {}),
        ...(tags.length ? {'#t': [...tags]} : {}),
      }, this.now(), this.maxRecords)
    }
    const pager = history.pager, source = relaySource(url)
    // At most four reads drain a dense second (300, 600, 1000) and
    // check the next second. Never silently skip an unfilled boundary.
    for (let round = 0; round < (options.rounds??4) && this.running&&!options.signal?.aborted; round++) {
      if (this.inventoryFull) return { limited: true }
      if (history.requests >= (options.maxRequests??MAX_HISTORY_REQUESTS)) { history.limited = true; return { limited: true } }
      if(options.requestBudget){if(options.requestBudget.count>=options.requestBudget.max){history.limited=true;return{limited:true}}options.requestBudget.count++}
      const request = pager.beginPage()
      if (!request) return history.limited ? {limited:true} : {}
      const until = request.filter.until!, limit = request.filter.limit!
      history.cursor = until
      void this.recovery?.recover(request.filter)
      history.requests++
      const page = await this.readHistory(url, until, limit, {...options,
        observe: event => { pager.observe(request.token, {event, source, priority: SOURCE_PRIORITY_RELAY}) },
      })
      const outcome = pager.finishPage(request.token, page.error || page.limited ? 'partial' : 'complete')
      if (page.error || page.limited) return page
      history.answered=true
      if (outcome.status === 'exhausted') { history.exhausted = true; return {} }
      if (outcome.status === 'limited') { history.limited = true; return {limited:true} }
      if (outcome.oldest !== undefined && outcome.oldest < until) { history.cursor = outcome.oldest; return {} }
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
        const filter: MarketFilter = options.bitcoin ? bitcoinFilter({kinds:[],until,limit}) : {kinds:[LISTING_KIND],until,limit}
        if (this.authors !== null) filter.authors = this.authors
        const tags=options.tags??this.tags;if(options.search){filter.search=options.search;delete filter.until}else if(tags.length)filter['#t']=tags
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
          const scoped=options.search?(!this.authorSet||this.authorSet.has(listing.author))&&matchesLiteralSearch(listingSearchText(listing),options.search):options.tags?(!this.authorSet||this.authorSet.has(listing.author))&&listing.tags.some(tag=>options.tags.includes(tag)):this.matchesFeed(listing)
          if (listing.rawEvent.kind !== (options.bitcoin ? BITCOIN_KIND : LISTING_KIND) || (!options.search&&listing.createdAt > until) || !scoped) { invalid = true; return }
          if (!accepted.has(listing.eventId) && accepted.size >= limit) { finish({ error: 'Older response exceeded its limit.' }); return }
          accepted.add(listing.eventId)
          oldest = Math.min(oldest ?? listing.createdAt, listing.createdAt)
          options.observe?.(listing.rawEvent as NostrVerifiedEvent)
          this.acceptListing(listing)
          if (this.inventoryFull) finish({ limited: true })
        } catch { invalid = true }
      }
      socket.onerror = () => finish({ error: 'Connection failed.' })
      socket.onclose = () => finish({ error: 'Connection closed.' })
    })
  }

  request(connection: RelayConnection) {
    if (connection.url === this.mapRelay) return
    connection.ready = false
    connection.initialOldest = null
    connection.bitcoinOldest = null
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
      if (this.hasInventoryQuery) filters.push(bitcoinFilter(filters[0]))
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
    clearTimeout(connection.geoTimer)
    connection.failed = true
    clearTimeout(connection.timer)
    clearTimeout(connection.retry)
    try {
      if (connection.url !== this.mapRelay && connection.socket?.readyState === 1) connection.socket.send(JSON.stringify(['CLOSE', connection.subscription]))
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
    const contexts = [...this.connections.values()].filter(connection => connection.url !== this.mapRelay)
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
