import { verifyEvent } from 'nostr-tools/pure'
import { locationFromTags } from './map/geohash.js'

export const DEFAULT_RELAYS = Object.freeze(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'])
export const LISTING_KIND = 30402
export const MAX_RECORDS = 1000
const MAX_EVENT_BYTES = 65536
const MAX_FRAME_BYTES = MAX_EVENT_BYTES + 2048
const HISTORY_PAGE_SIZE = 300
const HISTORY_TIMEOUT = 12000
const MAX_HISTORY_REQUESTS = 32
const MAX_HISTORY_BYTES = 16 * 1024 * 1024
const encoder = new TextEncoder()
const seconds = () => Math.floor(Date.now() / 1000)
const length = value => Array.from(value).length
const bytes = value => encoder.encode(value).length
const hex = (value, size) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(value)
const fail = message => { throw new Error(message) }

function singleton(event, name) {
  const tags = event.tags.filter(tag => tag[0] === name)
  if (tags.length > 1) fail(`Duplicate ${name} field`)
  return tags[0]?.[1]
}

/** Verify and normalise a NIP-99 record. Sold/expired records are valid tombstones. */
export function parseEvent(input, { now = seconds() } = {}) {
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
  const side = singleton(event, 'market') ?? 'offer'
  if (side !== 'offer' && side !== 'request') fail('Invalid listing type')
  const location = singleton(event, 'location') ?? ''
  const geo = locationFromTags(event.tags)
  const tags = event.tags.filter(tag => tag[0] === 't' && typeof tag[1] === 'string').map(tag => tag[1])
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
  return Object.freeze({
    id: `${event.pubkey}:${identifier}`, eventId: event.id, author: event.pubkey,
    identifier, title, description: event.content, price, currency, location,
    geohash: geo?.geohash ?? null, coordinates: geo?.coordinates ?? null, locationBounds: geo?.bounds ?? null,
    category, tags: Object.freeze(tags), imageUrl, side, createdAt: event.created_at, expiration, status,
  })
}

/** NIP-01 tie break: the lowest event ID wins equal timestamps. */
export function isNewer(candidate, previous) {
  return !previous || candidate.createdAt > previous.createdAt ||
    (candidate.createdAt === previous.createdAt && candidate.eventId < previous.eventId)
}

function applyListing(records, listing, maxRecords) {
  const previous = records.get(listing.id)
  if (!isNewer(listing, previous)) return false
  // Do not evict tombstones to make room: an older relay replay could otherwise
  // resurrect a sold/expired listing. The bound is per browser client lifetime.
  if (!previous && records.size >= maxRecords) return false
  records.set(listing.id, listing)
  return true
}

/** Mutates a caller-owned Map only after successful signature/field validation. */
export function applyEvent(records, event, { now = seconds(), maxRecords = MAX_RECORDS } = {}) {
  if (!(records instanceof Map)) fail('Listing store must be a Map')
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 5000) fail('Invalid listing capacity')
  return applyListing(records, parseEvent(event, { now }), maxRecords)
}

export function visibleListings(records, { now = seconds() } = {}) {
  return [...records.values()]
    .filter(item => item.status === 'active' && (item.expiration === null || item.expiration > now))
    .sort((a, b) => b.createdAt - a.createdAt || a.eventId.localeCompare(b.eventId))
}

export function validateRelays(relays) {
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

function feedTags(tags) {
  if (!Array.isArray(tags) || tags.length > 8 || tags.some(tag => typeof tag !== 'string' || !tag || length(tag) > 60)) fail('Choose up to eight exact tags, each at most 60 characters')
  return Object.freeze([...new Set(tags)])
}

function feedAuthors(authors) {
  if (authors === null) return null
  if (!Array.isArray(authors) || authors.length > 256 || authors.some(author => !hex(author, 64))) fail('Choose up to 256 public authors')
  return Object.freeze([...new Set(authors)])
}

function targetFilter(targetId) {
  if (targetId === undefined || targetId === null) return null
  if (typeof targetId !== 'string' || targetId[64] !== ':' || !hex(targetId.slice(0, 64), 64)) fail('Invalid listing link')
  const identifier = targetId.slice(65)
  if (!identifier || bytes(identifier) > 160) fail('Invalid listing link')
  return { kinds: [LISTING_KIND], authors: [targetId.slice(0, 64)], '#d': [identifier], limit: 1 }
}

/** Read-only relay client. Holds no signing keys and never publishes. */
export class MarketRelayClient {
  constructor({ relays = DEFAULT_RELAYS, onChange = () => {}, onStatus = () => {}, onPagination = () => {}, historyPageSize = HISTORY_PAGE_SIZE, records = new Map(), maxRecords = MAX_RECORDS, WebSocketImpl = globalThis.WebSocket, now = seconds, targetId, tags = [], authors = null } = {}) {
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
    this.WebSocket = WebSocketImpl
    this.now = now
    this.running = false
    this.connections = new Map()
    this.seen = new Set()
    this.changeTimer = null
    this.expiryTimer = null
    this.lastVisible = null
    this.lastStatus = ''
  }

  start() {
    if (this.running) return this
    if (this.hasQueries && typeof this.WebSocket !== 'function') fail('This browser cannot connect to message servers')
    this.running = true
    if (this.hasQueries) for (const url of this.relays) this.connect(url)
    this.emitStatus()
    this.emitChange()
    this.emitPagination()
    if (this.hasQueries) this.expiryTimer = setInterval(() => this.emitChange(), 1000)
    return this
  }

  matchesFeed(listing) {
    return (this.authorSet === null || this.authorSet.has(listing.author)) &&
      (!this.tags.length || this.tags.some(tag => listing.tags?.includes(tag)))
  }

  listings() {
    return visibleListings(this.records, { now: this.now() })
      .filter(listing => listing.id === this.targetId || this.matchesFeed(listing))
  }

  refresh() {
    if (!this.running) return this.start()
    if (!this.hasQueries) { this.emitStatus(); this.emitChange(); return this }
    for (const url of this.relays) {
      const connection = this.connections.get(url)
      if (connection?.socket?.readyState === 1 && !connection.failed) this.request(connection)
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
    const connection = { url, attempt, socket: null, failed: false, ready: false, subscription: `market-${Math.random().toString(36).slice(2, 14)}`, timer: null, retry: null, frameStart: Date.now(), frames: 0 }
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
      this.emitStatus()
    }
    socket.onmessage = ({ data }) => {
      if (!current() || typeof data !== 'string') return
      if (Date.now() - connection.frameStart > 10000) { connection.frames = 0; connection.frameStart = Date.now() }
      if (++connection.frames > 600 || data.length > MAX_FRAME_BYTES || bytes(data) > MAX_FRAME_BYTES) { this.failed(connection); return }
      let frame
      try { frame = JSON.parse(data) } catch { return }
      if (!Array.isArray(frame) || frame[1] !== connection.subscription) return
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
          const listing = parseEvent(frame[2], { now: this.now() })
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

  acceptListing(listing) {
    // Preserve newer revisions of known coordinates even if their tags changed.
    if (listing.id !== this.targetId && !this.matchesFeed(listing) && !this.records.has(listing.id)) return
    if (this.seen.has(listing.eventId)) return
    this.seen.add(listing.eventId)
    if (this.seen.size > 4000) this.seen.delete(this.seen.values().next().value)
    const capacity = this.targetId && listing.id !== this.targetId && !this.records.has(this.targetId) ? this.maxRecords - 1 : this.maxRecords
    if (applyListing(this.records, listing, capacity)) this.scheduleChange()
  }

  pagination() {
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

  async loadOlderFrom(url, history) {
    history.started = true
    history.cursor ??= history.initialOldest ?? this.now()
    let limit = this.historyPageSize
    // At most four reads drain a dense second (300, 600, 1000) and
    // check the next second. Never silently skip an unfilled boundary.
    for (let round = 0; round < 4 && this.running; round++) {
      if (this.records.size >= this.maxRecords) return { limited: true }
      if (history.requests >= MAX_HISTORY_REQUESTS) { history.limited = true; return { limited: true } }
      const until = history.cursor
      history.requests++
      const page = await this.readHistory(url, until, limit)
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
        limit = this.historyPageSize
      }
    }
    return { error: this.running ? 'History boundary needs another request.' : 'Loading stopped.' }
  }

  readHistory(url, until, limit) {
    return new Promise(resolve => {
      const subscription = `older-${Math.random().toString(36).slice(2, 14)}`
      let socket, ended = false, timer, frames = 0, receivedBytes = 0, invalid = false, oldest = null
      const accepted = new Set()
      const finish = result => {
        if (ended) return
        ended = true
        clearTimeout(timer)
        this.historyReaders.delete(finish)
        if (socket) {
          socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
          try { if (socket.readyState === 1) socket.send(JSON.stringify(['CLOSE', subscription])) } catch { /* Closed. */ }
          try { socket.close() } catch { /* Closed. */ }
        }
        resolve(result)
      }
      this.historyReaders.add(finish)
      timer = setTimeout(() => finish({ error: 'Older listings timed out.' }), HISTORY_TIMEOUT)
      try { socket = new this.WebSocket(url) } catch { finish({ error: 'Connection failed.' }); return }
      socket.onopen = () => {
        if (ended || !this.running) { finish({ error: 'Loading stopped.' }); return }
        const filter = { kinds: [LISTING_KIND], until, limit }
        if (this.authors !== null) filter.authors = this.authors
        if (this.tags.length) filter['#t'] = this.tags
        try { socket.send(JSON.stringify(['REQ', subscription, filter])) }
        catch { finish({ error: 'Request failed.' }) }
      }
      socket.onmessage = ({ data }) => {
        if (ended || typeof data !== 'string') return
        if (data.length > MAX_FRAME_BYTES) { finish({ error: 'Older response exceeded its limit.' }); return }
        const size = bytes(data)
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
          const listing = parseEvent(frame[2], { now: this.now() })
          if (listing.createdAt > until || !this.matchesFeed(listing)) { invalid = true; return }
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

  request(connection) {
    connection.ready = false
    clearTimeout(connection.timer)
    try {
      const filters = []
      if (this.hasInventoryQuery) {
        const inventory = { kinds: [LISTING_KIND], limit: 300 }
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

  failed(connection) {
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

  dispose(connection) {
    connection.failed = true
    clearTimeout(connection.timer)
    clearTimeout(connection.retry)
    try {
      if (connection.socket?.readyState === 1) connection.socket.send(JSON.stringify(['CLOSE', connection.subscription]))
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
    const value = { state, connected, total: this.hasQueries ? this.relays.length : 0, message }
    const fingerprint = JSON.stringify(value)
    if (fingerprint === this.lastStatus) return
    this.lastStatus = fingerprint
    this.onStatus(value)
  }
}
