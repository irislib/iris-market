import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey, getPublicKey, verifiedSymbol } from 'nostr-tools'
import { DEFAULT_CURRENCY, RATE_POLICY, SNORT_RATES, COINBASE_RATES_URL, normalizeCurrency, parseSnortRateEvent, parseCoinbaseRates, fetchCoinbaseRates, setupRates, convert, formatPrice } from '../src/currency.js'

const now = 1_790_000_000
const body = { data: { currency: 'BTC', rates: { BTC: '1.0', EUR: '90000', USD: '100000', GBP: '80000', JPY: '15000000' } } }
const snapshot = at => ({ rates: parseCoinbaseRates(body, { now: at }) })
const secret = generateSecretKey(), publisher = getPublicKey(secret)
const signedRate = (tags = [['d', 'BTCEUR', '90001', '89999', '89000', '91000']], created_at = now) => finalizeEvent({ kind: 1009, created_at, tags, content: '' }, secret)
const freeze = event => { event.tags.forEach(Object.freeze); Object.freeze(event.tags); return Object.freeze(event) }

test('currency aliases share exact Bitcoin units and EUR is the explicit default', () => {
  assert.equal(DEFAULT_CURRENCY, 'EUR')
  for (const alias of ['sat', 'SATS', 'satoshi', 'SATOSHIS']) assert.equal(normalizeCurrency(alias), 'SATS')
  assert.equal(normalizeCurrency('xbt'), 'BTC')
  assert.equal(normalizeCurrency(' eur '), 'EUR')
  assert.equal(normalizeCurrency('javascript:bad'), '')
  assert.equal(convert('1.1', 'BTC', 'SATS').amount, 110000000)
  assert.equal(convert('0.00000001', 'BTC', 'SAT').amount, 1)
  assert.equal(convert('100000000', 'SATOSHI', 'BTC').amount, 1)
  assert.equal(convert('100000000', 'SATS', 'BTC').approximate, false)
  assert.equal(convert('25.50', 'EUR', 'EUR').amount, 25.5)
})

test('foreign and satoshi prices convert through consistent BTC base rates for sorting', () => {
  const rates = snapshot(now)
  assert.equal(convert('100', 'USD', 'EUR', rates, { now }).amount, 90)
  assert.equal(convert('100000', 'SATS', 'EUR', rates, { now }).amount, 90)
  assert.equal(convert('90', 'EUR', 'SATS', rates, { now }).amount, 100000)
  assert.equal(convert('90', 'EUR', 'GBP', rates, { now }).amount, 80)
  assert.equal(convert('1', 'XYZ', 'EUR', rates, { now }), null)
  assert.equal(convert('-10', 'USD', 'EUR', rates, { now }), null)
  assert.equal(convert('Infinity', 'USD', 'EUR', rates, { now }), null)
  assert.equal(convert('1e309', 'USD', 'EUR', rates, { now }), null)
})

test('formatted estimates retain original amounts and expose source, time, and sort value', () => {
  const result = formatPrice({ price: '100000', currency: 'SAT' }, { rates: snapshot(now), now, locale: 'en-US' })
  assert.equal(result.primary, '€90.00')
  assert.equal(result.original, '100,000 sats')
  assert.equal(result.converted, 90)
  assert.equal(result.source, 'Coinbase')
  assert.equal(result.updatedAt, now)
  assert.equal(result.stale, false)
  assert.equal(formatPrice({ price: '0.005', currency: 'BTC' }, { preferredCurrency: 'SATS', locale: 'en-US' }).primary, '500,000 sats')
  assert.equal(formatPrice({ price: '54.99', currency: 'EUR' }, { locale: 'en-US' }).primary, '€54.99')
  assert.equal(formatPrice({ price: '123456789012345.123', currency: 'EUR' }, { locale: 'en-US' }).primary, '123456789012345.123 EUR')
  assert.notEqual(formatPrice({ price: '1', currency: 'SATS' }, { rates: snapshot(now), now, locale: 'en-US' }).primary, '€0.00')
})

test('missing, stale and expired rates never silently become current price estimates', () => {
  const listing = { price: '100', currency: 'USD' }
  const missing = formatPrice(listing, { now, locale: 'en-US' })
  assert.equal(missing.primary, '$100.00'); assert.equal(missing.converted, null); assert.equal(missing.approximate, false)
  const stale = formatPrice(listing, { rates: snapshot(now - 901), now, locale: 'en-US' })
  assert.equal(stale.primary, '€90.00'); assert.equal(stale.stale, true); assert.equal(stale.updatedAt, now - 901)
  const expired = formatPrice(listing, { rates: snapshot(now - RATE_POLICY.maxAgeSeconds - 1), now, locale: 'en-US' })
  assert.equal(expired.primary, '$100.00'); assert.equal(expired.converted, null)
  assert.equal(formatPrice({ price: '', currency: 'EUR' }).primary, 'Negotiable')
  assert.equal(formatPrice({ price: '0', currency: 'SATS' }).primary, 'Free')
  assert.equal(formatPrice({ price: '0', currency: 'SATS' }).converted, 0)
})

test('Snort schema requires the configured signer, independently verified fields, and bounded age', () => {
  const signed = freeze(signedRate())
  assert.equal(parseSnortRateEvent(signed, { now }), null)
  const parsed = parseSnortRateEvent(signed, { now, expectedPublisher: publisher })
  assert.equal(parsed.currency, 'EUR'); assert.equal(parsed.value, 90001); assert.equal(parsed.source, 'Snort')
  assert.equal(parsed.updatedAt, now)
  const forged = freeze({ ...signed, sig: '0'.repeat(128), [verifiedSymbol]: true })
  assert.equal(parseSnortRateEvent(forged, { now, expectedPublisher: publisher }), null)
  assert.equal(parseSnortRateEvent(signedRate(undefined, now + 61), { now, expectedPublisher: publisher }), null)
  assert.equal(parseSnortRateEvent(signedRate(undefined, now - RATE_POLICY.maxAgeSeconds - 1), { now, expectedPublisher: publisher }), null)
  assert.equal(parseSnortRateEvent(signedRate(undefined, now - 1000), { now, expectedPublisher: publisher }).updatedAt, now - 1000)
})

test('malformed Snort quotes cannot define rates or override canonical Bitcoin units', () => {
  for (const tags of [[['d', 'BTCEUR', '0', '1', '1', '1']], [['d', 'BTCEUR', '1', '2', '1', '3']], [['d', 'BTCEUR', '2', '1', '3', '1']], [['d', 'BTCEUR', 'NaN', '1', '1', '3']], [['d', 'BTCBTC', '2', '1', '1', '3']], [['d', 'BTCEUR', '2', '1', '1', '3'], ['d', 'BTCUSD', '2', '1', '1', '3']]]) {
    assert.equal(parseSnortRateEvent(signedRate(tags), { now, expectedPublisher: publisher }), null)
  }
})

test('Coinbase parsing enforces BTC base, positive bounded quotes and fixed Bitcoin units', () => {
  assert.equal(parseCoinbaseRates(body, { now }).EUR.value, 90000)
  assert.throws(() => parseCoinbaseRates({ data: { ...body.data, currency: 'USD' } }, { now }), /Invalid/)
  assert.throws(() => parseCoinbaseRates({ data: { currency: 'BTC', rates: { BTC: '2', EUR: '1' } } }, { now }), /base/)
  const rates = parseCoinbaseRates({ data: { currency: 'BTC', rates: { BTC: '1', SATS: '3', EUR: '90000', XYZ: '-1', ZZZ: 'Infinity', BAD: '0' } } }, { now })
  assert.equal(rates.SATS, undefined); assert.equal(rates.XYZ, undefined); assert.equal(rates.ZZZ, undefined); assert.equal(rates.BAD, undefined)
  const oversized = Object.fromEntries(Array.from({ length: RATE_POLICY.maxRates + 1 }, (_, i) => [`CODE${i}`, '1']))
  assert.throws(() => parseCoinbaseRates({ data: { currency: 'BTC', rates: oversized } }), /size/)
})

test('HTTP reads are public, fresh, bounded and keep the browser fetch receiver', async () => {
  const rates = await fetchCoinbaseRates({ now: () => now, fetchImpl: function (url, options) {
    assert.equal(this, globalThis); assert.equal(url, COINBASE_RATES_URL)
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error')
    return Promise.resolve(Response.json(body))
  } })
  assert.equal(rates.EUR.updatedAt, now)
  await assert.rejects(fetchCoinbaseRates({ now: () => now, fetchImpl: async () => new Response('', { headers: { 'content-length': String(RATE_POLICY.maxHttpBytes + 1) } }) }), /too large/)
  await assert.rejects(fetchCoinbaseRates({ now: () => now, fetchImpl: async () => new Response(new Uint8Array(RATE_POLICY.maxHttpBytes + 1)) }), /too large/)
  await assert.rejects(fetchCoinbaseRates({ now: () => now, fetchImpl: async () => Response.json(body, { headers: { date: new Date((now - 901) * 1000).toUTCString() } }) }), /stale/)
})

test('rate setup queries only the known public publisher and uses configured relays unchanged', async () => {
  const relays = ['wss://custom.example/'], requests = [], calls = []
  const rates = setupRates({ getRelays: () => relays, now: () => now, currencies: ['EUR', 'USD', 'SATS'],
    query: async (filters, options) => { requests.push({ filters, options }); return { events: [] } },
    fetchImpl: async (...args) => { calls.push(args); return Response.json(body) },
  })
  try {
    assert.equal((await rates.ready).status, 'fresh')
    assert.deepEqual(requests[0].filters[0].authors, [SNORT_RATES.pubkey])
    assert.deepEqual(requests[0].filters[0].kinds, [1009])
    assert.deepEqual(requests[0].filters[0]['#d'], ['BTCEUR', 'BTCUSD'])
    assert.deepEqual(requests[0].options.relays, relays)
    assert.equal(requests[0].options.localEcho, false)
    assert.equal(calls.length, 1)
    await rates.refresh(); assert.equal(calls.length, 1)
    assert.equal(rates.snapshot().rates.EUR.source, 'Coinbase')
  } finally { rates.close() }
})

test('failed refresh exposes last-known estimates as stale and drops them after four hours', async () => {
  let at = now, fail = false, changes = 0
  const rates = setupRates({ getRelays: () => ['wss://relay.example'], now: () => at, currencies: ['EUR'], onChange: () => changes++,
    query: async () => ({ events: [] }), fetchImpl: async () => { if (fail) throw Error('Offline'); return Response.json(body) },
  })
  try {
    await rates.ready
    fail = true; at += 901; await rates.refresh()
    assert.equal(rates.snapshot().status, 'stale')
    assert.equal(formatPrice({ price: '100', currency: 'USD' }, { rates: rates.snapshot(), now: at }).stale, true)
    at += RATE_POLICY.maxAgeSeconds; await rates.refresh()
    assert.equal(rates.snapshot().status, 'unavailable')
    assert.equal(formatPrice({ price: '100', currency: 'USD' }, { rates: rates.snapshot(), now: at }).converted, null)
    assert.equal(changes, 3)
  } finally { rates.close() }
})

test('closing cancels an in-flight HTTP read and prevents late UI updates', async () => {
  let started, updates = 0
  const began = new Promise(resolve => { started = resolve })
  const rates = setupRates({ currencies: ['EUR'], onChange: () => updates++, query: async () => ({ events: [] }),
    fetchImpl: (_, { signal }) => { started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
  })
  await began; rates.close(); await rates.ready
  assert.equal(updates, 0)
  assert.equal((await rates.refresh()).status, 'unavailable')
})
