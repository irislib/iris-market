import { verifyEvent } from 'nostr-tools/pure'
import { createPrivateTransport } from './messaging/transport.js'

export const DEFAULT_CURRENCY = 'EUR'
export const CURRENCIES = Object.freeze(['EUR', 'USD', 'GBP', 'SEK', 'NOK', 'DKK', 'CHF', 'CAD', 'AUD', 'JPY', 'CNY', 'INR', 'SATS', 'BTC'])
export const RATE_POLICY = Object.freeze({ freshSeconds: 15 * 60, maxAgeSeconds: 4 * 60 * 60, refreshMs: 5 * 60 * 1000, requestTimeoutMs: 8000, nostrTimeoutMs: 2500, maxHttpBytes: 128 * 1024, maxRates: 1024, maxNostrEvents: 64 })
// Source schema and publisher reviewed at this immutable Snort revision:
// https://github.com/v0l/snort/blob/d750544e9ba29f929bbc019a747399359fa9f9fa/packages/app/src/Hooks/useRates.tsx
// https://github.com/v0l/snort/blob/d750544e9ba29f929bbc019a747399359fa9f9fa/packages/app/src/Utils/Const.ts
export const SNORT_RATES = Object.freeze({ pubkey: '84de35e2584d2b144aae823c9ed0b0f3deda09648530b93d1a2a146d1dea9864', kind: 1009 })
// Public, unauthenticated units per 1 BTC; display estimates only.
// https://docs.cdp.coinbase.com/coinbase-app/track-apis/exchange-rates
export const COINBASE_RATES_URL = 'https://api.coinbase.com/v2/exchange-rates?currency=BTC'
const SATS_PER_BTC = 100_000_000
const encoder = new TextEncoder()
const seconds = () => Math.floor(Date.now() / 1000)
const decimal = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const unitRates = Object.freeze({ BTC: 1, SATS: SATS_PER_BTC })

export function normalizeCurrency(value) {
  if (typeof value !== 'string') return ''
  const code = value.trim().toUpperCase()
  if (['SAT', 'SATS', 'SATOSHI', 'SATOSHIS'].includes(code)) return 'SATS'
  if (code === 'XBT') return 'BTC'
  return /^[A-Z]{3,12}$/.test(code) ? code : ''
}
function numeric(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !decimal.test(value))) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}
function positive(value) {
  const number = numeric(value)
  return number > 0 && number <= 1e18 ? number : null
}
function fresh(record, now) { return record && now - record.updatedAt <= RATE_POLICY.freshSeconds && record.updatedAt <= now + 60 }
function usable(record, now) { return record && positive(record.value) !== null && Number.isSafeInteger(record.updatedAt) && record.updatedAt <= now + 60 && now - record.updatedAt <= RATE_POLICY.maxAgeSeconds }

/** expectedPublisher exists for deterministic protocol tests; production always uses SNORT_RATES.pubkey. */
export function parseSnortRateEvent(raw, { now = seconds(), expectedPublisher = SNORT_RATES.pubkey } = {}) {
  try {
    if (raw?.kind !== SNORT_RATES.kind || raw.pubkey !== expectedPublisher || !Number.isSafeInteger(raw.created_at) || raw.created_at > now + 60 || now - raw.created_at > RATE_POLICY.maxAgeSeconds) return null
    if (typeof raw.content !== 'string' || raw.content.length > 8192 || !Array.isArray(raw.tags) || raw.tags.length > 64 || !raw.tags.every(tag => Array.isArray(tag) && tag.length <= 12 && tag.every(value => typeof value === 'string' && value.length <= 1024))) return null
    const event = { id: raw.id, pubkey: raw.pubkey, sig: raw.sig, kind: raw.kind, created_at: raw.created_at, tags: raw.tags.map(tag => [...tag]), content: raw.content }
    if (encoder.encode(JSON.stringify(event)).length > 16384 || !verifyEvent(event)) return null
    const tags = event.tags.filter(tag => tag[0] === 'd')
    if (tags.length !== 1 || tags[0].length < 6 || !/^BTC[A-Z]{3}$/.test(tags[0][1])) return null
    const [_, symbol, ask, bid, low, high] = tags[0], values = [ask, bid, low, high].map(positive)
    if (values.some(value => value === null) || values[0] < values[1] || values[2] > values[3]) return null
    const currency = symbol.slice(3)
    if (currency === 'BTC') return null
    return Object.freeze({ currency, value: values[0], source: 'Snort', updatedAt: event.created_at, eventId: event.id })
  } catch { return null }
}

export function parseCoinbaseRates(body, { now = seconds() } = {}) {
  if (body?.data?.currency !== 'BTC' || !body.data.rates || typeof body.data.rates !== 'object' || Array.isArray(body.data.rates)) throw new Error('Invalid exchange-rate response.')
  const entries = Object.entries(body.data.rates)
  if (entries.length > RATE_POLICY.maxRates || numeric(body.data.rates.BTC) !== 1) throw new Error('Invalid exchange-rate base or size.')
  const rates = Object.create(null)
  for (const [key, raw] of entries) {
    const currency = normalizeCurrency(key), value = positive(raw)
    if (!currency || currency !== key || currency in unitRates || value === null) continue
    rates[currency] = Object.freeze({ value, source: 'Coinbase', updatedAt: now })
  }
  if (!Object.keys(rates).length) throw new Error('No usable exchange rates.')
  return Object.freeze(rates)
}

async function readJSON(response, signal) {
  if (!response.ok || !response.body) throw new Error('Could not load exchange rates.')
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > RATE_POLICY.maxHttpBytes)) throw new Error('Exchange-rate response is too large.')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > RATE_POLICY.maxHttpBytes) throw new Error('Exchange-rate response is too large.')
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

export async function fetchCoinbaseRates({ fetchImpl = globalThis.fetch, signal, now = seconds } = {}) {
  signal?.throwIfAborted()
  const controller = new AbortController(), abort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException('Exchange-rate lookup timed out.', 'TimeoutError')), RATE_POLICY.requestTimeoutMs)
  try {
    const response = await fetchImpl.call(globalThis, COINBASE_RATES_URL, { signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' })
    const receivedAt = now(), serverDate = Date.parse(response.headers.get('date') || '') / 1000
    if (Number.isFinite(serverDate) && (serverDate > receivedAt + 60 || receivedAt - serverDate > RATE_POLICY.freshSeconds)) throw new Error('Exchange-rate response is stale.')
    // Coinbase has no quote timestamp here. This is explicitly retrieval time,
    // not a claim about when its underlying market price last changed.
    return parseCoinbaseRates(await readJSON(response, controller.signal), { now: receivedAt })
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

/** No secrets, publishing, user relay changes, or persistent rate tracking. */
export function setupRates({ getRelays = () => [], onChange = () => {}, fetchImpl = globalThis.fetch, query, WebSocketImpl = globalThis.WebSocket, now = seconds, currencies = CURRENCIES } = {}) {
  const ownedTransport = query ? null : createPrivateTransport(getRelays, { WebSocketImpl })
  const queryEvents = query || ((...args) => ownedTransport.query(...args))
  const requested = [...new Set(currencies.map(normalizeCurrency).filter(code => /^[A-Z]{3}$/.test(code) && code !== 'BTC'))].slice(0, 32)
  const values = new Map()
  let inflight = null, active = null, closed = false, error = null
  function snapshot() {
    const at = now(), rates = Object.create(null)
    for (const [code, rate] of values) if (usable(rate, at)) rates[code] = rate
    const available = Object.values(rates)
    return Object.freeze({ rates: Object.freeze(rates), status: available.some(rate => fresh(rate, at)) ? 'fresh' : available.length ? 'stale' : 'unavailable', error })
  }
  function refresh() {
    if (closed) return Promise.resolve(snapshot())
    if (inflight) return inflight
    active = new AbortController()
    inflight = (async () => {
      let nostrFailed = false
      try {
        const result = await queryEvents([{ kinds: [SNORT_RATES.kind], authors: [SNORT_RATES.pubkey], '#d': requested.map(code => `BTC${code}`), since: now() - RATE_POLICY.maxAgeSeconds, limit: RATE_POLICY.maxNostrEvents }], { relays: getRelays(), sources: [], cache: 'network-only', localEcho: false, signal: active.signal, deadline: Date.now() + RATE_POLICY.nostrTimeoutMs })
        if (result.events.length > RATE_POLICY.maxNostrEvents) throw new Error('Rate response limit reached.')
        for (const event of result.events) {
          const rate = parseSnortRateEvent(event, { now: now() })
          if (!rate || !requested.includes(rate.currency)) continue
          const previous = values.get(rate.currency)
          if (!previous || fresh(rate, now()) || !fresh(previous, now())) {
            if (previous?.source === 'Snort' && (previous.updatedAt > rate.updatedAt || previous.updatedAt === rate.updatedAt && previous.eventId <= rate.eventId)) continue
            values.set(rate.currency, rate)
          }
        }
      } catch { nostrFailed = true }
      if (closed) return snapshot()
      const missing = requested.some(code => !fresh(values.get(code), now()) || values.get(code)?.source === 'Coinbase' && now() - values.get(code).updatedAt >= RATE_POLICY.refreshMs / 1000)
      if (missing || !values.size) {
        try {
          const fallback = await fetchCoinbaseRates({ fetchImpl, signal: active.signal, now })
          for (const [code, rate] of Object.entries(fallback)) if (values.get(code)?.source !== 'Snort' || !fresh(values.get(code), now())) values.set(code, rate)
          error = null
        } catch { error = 'Live rates unavailable. Original prices and recent saved estimates remain available.' }
      } else error = nostrFailed && !Object.values(snapshot().rates).some(rate => fresh(rate, now())) ? 'Live rates unavailable.' : null
      if (!closed) onChange(snapshot())
      return snapshot()
    })().finally(() => { inflight = null; active = null })
    return inflight
  }
  const timer = setInterval(() => { void refresh() }, RATE_POLICY.refreshMs)
  timer.unref?.()
  const ready = refresh()
  return { ready, refresh, snapshot, close() { closed = true; clearInterval(timer); active?.abort(); ownedTransport?.close() } }
}

function shiftDecimal(value, places) {
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e')
  return Number(`${coefficient}e${Number(exponent) + places}`)
}

export function convert(amount, from, to, snapshot, { now = seconds() } = {}) {
  const value = numeric(amount), origin = normalizeCurrency(from), currency = normalizeCurrency(to)
  if (value === null || !origin || !currency) return null
  if (origin === currency || value === 0) return { amount: value, currency, approximate: false, source: null, updatedAt: null, stale: false }
  if (origin in unitRates && currency in unitRates) {
    const converted = shiftDecimal(amount, origin === 'BTC' ? 8 : -8)
    return Number.isFinite(converted) ? { amount: converted, currency, approximate: false, source: null, updatedAt: null, stale: false } : null
  }
  const rate = code => code in unitRates ? { value: unitRates[code], source: null, updatedAt: now } : snapshot?.rates?.[code]
  const base = rate(origin), quote = rate(currency)
  if (!usable(base, now) || !usable(quote, now)) return null
  const converted = (value / base.value) * quote.value
  if (!Number.isFinite(converted) || converted < 0 || value > 0 && converted === 0) return null
  const records = [base, quote].filter(record => record.source)
  return { amount: converted, currency, approximate: true, source: [...new Set(records.map(record => record.source))].join(' + '), updatedAt: Math.min(...records.map(record => record.updatedAt)), stale: records.some(record => !fresh(record, now)) }
}

function fractionDigits(value) {
  const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e')
  return Math.min(20, Math.max(0, (coefficient.split('.')[1]?.length || 0) - Number(exponent)))
}
function displayAmount(value, currency, locale, original = false) {
  const number = numeric(value)
  if (number === null) return `${String(value).slice(0, 32)} ${currency}`.trim()
  // Preserve high-precision original text instead of rounding through Number.
  if (original && String(value).replace(/[^0-9]/g, '').replace(/^0+/, '').length > 15) return `${value} ${currency}`
  if (currency === 'SATS' || currency === 'BTC' || currency.length !== 3) {
    const digits = original ? fractionDigits(value) : currency === 'BTC' ? 8 : 0
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(number)} ${currency === 'SATS' ? 'sats' : currency}`
  }
  try {
    const baseDigits = new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
    const smallDigits = number > 0 && number < 0.01 ? Math.min(8, Math.ceil(-Math.log10(number)) + 1) : baseDigits
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: original ? Math.max(baseDigits, fractionDigits(value)) : Math.max(baseDigits, smallDigits) }).format(number)
  } catch { return `${value} ${currency}` }
}

export function formatPrice(listing, { preferredCurrency = DEFAULT_CURRENCY, rates, locale, now = seconds() } = {}) {
  const currency = normalizeCurrency(listing.currency), preferred = normalizeCurrency(preferredCurrency) || DEFAULT_CURRENCY
  const blank = { primary: 'Negotiable', original: null, approximate: false, source: null, updatedAt: null, converted: null, stale: false, currency }
  if (listing.price === '' || listing.price == null) return blank
  const value = numeric(listing.price)
  if (value === 0) return { ...blank, primary: 'Free', converted: 0, currency: preferred }
  const original = displayAmount(listing.price, currency, locale, true)
  const conversion = convert(listing.price, currency, preferred, rates, { now })
  if (!conversion) return { ...blank, primary: original }
  const changed = currency !== preferred
  return { primary: `${changed ? displayAmount(conversion.amount, preferred, locale, !conversion.approximate) : original}`, original: changed ? original : null,
    approximate: conversion.approximate, source: conversion.source, updatedAt: conversion.updatedAt, converted: conversion.amount, stale: conversion.stale, currency: preferred }
}
