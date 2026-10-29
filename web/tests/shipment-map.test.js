import test from 'node:test'
import assert from 'node:assert/strict'
import { createShipmentOverlay, shipmentFeatures } from '../src/map/shipment.ts'

const shipment = () => ({
  stops: [
    { id: 'a', label: 'Pickup', address: 'Private address', coordinates: [24.93, 60.17], status: 'completed' },
    { id: 'b', label: 'Handoff', coordinates: [24.95, 60.18], status: 'arrived' },
    { id: 'c', label: 'Delivery', coordinates: [24.97, 60.2], status: 'pending' },
  ],
  location: { coordinates: [24.94, 60.175], at: 1000, courierPubkey: 'a'.repeat(64) },
})
const courier = features => features.features.find(feature => feature.properties.kind === 'courier')
const points = features => features.features.filter(feature => feature.properties.kind === 'stop')

function mockMap() {
  const handlers = new Map(), sources = new Map(), layers = new Map(), attributes = new Map([['aria-label', 'Original map']]), fits = []
  let writes = 0
  return {
    fits,
    attributes,
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn) },
    off(name, fn) { handlers.get(name)?.delete(fn) },
    emit(name) { for (const fn of handlers.get(name) ?? []) fn() },
    getCanvas() { return { getAttribute: key => attributes.get(key) ?? null, setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key) } },
    getSource: id => sources.get(id),
    addSource(id, value) { assert(!sources.has(id)); sources.set(id, { ...value, setData(data) { this.data = data; writes++ } }) },
    getLayer: id => layers.get(id),
    addLayer(value) { assert(!layers.has(value.id)); layers.set(value.id, value) },
    setPaintProperty(id, key, value) { layers.get(id).paint[key] = value },
    fitBounds(bounds, options) { fits.push({ bounds, options }) },
    resetStyle() { sources.clear(); layers.clear() },
    get writes() { return writes },
    listenerCount() { return [...handlers.values()].reduce((sum, values) => sum + values.size, 0) },
  }
}
function clock(start = 1000) {
  let now = start, sequence = 0
  const timers = new Map()
  return {
    now: () => now,
    timers,
    setTimer(callback, milliseconds) { const id = ++sequence; timers.set(id, { callback, at: now + milliseconds / 1000 }); return id },
    clearTimer(id) { timers.delete(id) },
    advance(seconds) {
      now += seconds
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback() }
    },
  }
}

test('shipment display contains ordered stops, direct legs and current/completed state', () => {
  const input = shipment(), data = shipmentFeatures(input, 1000)
  assert.deepEqual(points(data).map(item => [item.properties.number, item.properties.status, item.properties.current]), [[1, 'completed', false], [2, 'arrived', true], [3, 'pending', false]])
  assert.equal(data.features.filter(item => item.properties.kind === 'leg').length, 2)
  assert(courier(data))
  assert(!JSON.stringify(data).includes('Private address'))
  assert(!JSON.stringify(data).includes(input.location.courierPubkey))
  input.stops[0].coordinates[0] = 0
  assert.equal(points(data)[0].geometry.coordinates[0], 24.93)
})

test('unknown coordinates retain waypoint numbering and break the connecting itinerary', () => {
  const input = shipment()
  input.stops[1].coordinates = null
  const data = shipmentFeatures(input, 1000)
  assert.deepEqual(points(data).map(item => item.properties.number), [1, 3])
  assert.equal(data.features.filter(item => item.properties.kind === 'leg').length, 0)
  assert(points(data).every(item => !item.properties.current))
})

test('invalid coordinates and oversized stop lists cannot create unbounded map data', () => {
  for (const coordinates of [undefined, null, [181, 0], [0, 91], [NaN, 0], [Infinity, 0], ['24', 60], [0, 0, 0]]) {
    assert.deepEqual(shipmentFeatures({ stops: [{ coordinates }], location: { coordinates, at: 1000 } }, 1000).features, [])
  }
  assert.equal(points(shipmentFeatures({ stops: Array.from({ length: 100 }, (_, index) => ({ id: String(index), coordinates: [index, 0] })) }, 1000)).length, 12)
  assert.deepEqual(shipmentFeatures(null, 1000).features, [])
})

test('courier location is visible only for a valid Unix timestamp younger than two minutes', () => {
  for (const [at, now, visible] of [[1000, 1000, true], [1000, 1119.999, true], [1000, 1120, false], [1000, 1121, false], [1001, 1000, false], [1000.5, 1001, false], [NaN, 1000, false], [Infinity, 1000, false], [-1, 0, false], [1000, NaN, false]]) {
    assert.equal(Boolean(courier(shipmentFeatures({ location: { coordinates: [0, 0], at } }, now))), visible)
  }
})

test('date-line legs are short split segments rather than lines across the world', () => {
  const data = shipmentFeatures({ stops: [{ coordinates: [179, 10] }, { coordinates: [-179, 12] }] }, 1000)
  const line = data.features.find(item => item.properties.kind === 'leg')
  assert.deepEqual(line.geometry, { type: 'MultiLineString', coordinates: [[[179, 10], [180, 11]], [[-180, 11], [-179, 12]]] })
  const edge = shipmentFeatures({ stops: [{ coordinates: [179, 10] }, { coordinates: [-180, 12] }] }, 1000).features.find(item => item.properties.kind === 'leg')
  assert.deepEqual(edge.geometry.coordinates, [[179, 10], [180, 12]])
})

test('private overlay creates numbered dashed itinerary without listing layers or discovery', () => {
  const map = mockMap(), time = clock(), overlay = createShipmentOverlay(map, time)
  overlay.setShipment(shipment())
  assert.equal(map.getSource('shipment-route'), undefined)
  map.emit('style.load')
  assert.equal(points(map.getSource('shipment-route').data).length, 3)
  assert.deepEqual(map.getLayer('shipment-legs').paint['line-dasharray'], [2, 2])
  assert.deepEqual(map.getLayer('shipment-stop-numbers').layout['text-field'], ['to-string', ['get', 'number']])
  assert.equal(map.getSource('market-listings'), undefined)
  assert.equal(map.listenerCount(), 2)
  assert.match(map.attributes.get('aria-label'), /not by driving directions/)
  overlay.destroy()
})

test('fresh marker expires without another order update and destruction clears timers', () => {
  const map = mockMap(), time = clock(), overlay = createShipmentOverlay(map, time)
  overlay.setShipment(shipment()); map.emit('load')
  assert(courier(map.getSource('shipment-route').data))
  assert.equal(time.timers.size, 1)
  time.advance(120)
  assert.equal(courier(map.getSource('shipment-route').data), undefined)
  assert.equal(time.timers.size, 0)
  overlay.setShipment({ ...shipment(), location: { coordinates: [0, 0], at: 1120 } })
  assert.equal(time.timers.size, 1)
  overlay.destroy()
  assert.equal(time.timers.size, 0)
  assert.equal(map.listenerCount(), 0)
  assert.equal(map.attributes.get('aria-label'), 'Original map')
  const writes = map.writes
  time.advance(120); map.emit('load'); overlay.setShipment(shipment())
  assert.equal(map.writes, writes)
})

test('route fits on coordinate changes but courier samples and status changes preserve the view', () => {
  const map = mockMap(), time = clock(), overlay = createShipmentOverlay(map, time), input = shipment()
  overlay.setShipment(input); map.emit('load')
  assert.equal(map.fits.length, 1)
  input.location.coordinates = [24.96, 60.19]; input.stops[1].status = 'completed'
  overlay.setShipment(input)
  assert.equal(map.fits.length, 1)
  input.stops[2].coordinates = [25, 60.3]; overlay.setShipment(input)
  assert.equal(map.fits.length, 2)
  overlay.destroy()
})

test('style replacement restores latest stops and expires stale courier without refitting', () => {
  const map = mockMap(), time = clock(), overlay = createShipmentOverlay(map, time)
  overlay.setShipment(shipment()); map.emit('load')
  overlay.beginStyleChange(true); map.resetStyle()
  time.advance(120)
  map.emit('style.load')
  assert.equal(points(map.getSource('shipment-route').data).length, 3)
  assert.equal(courier(map.getSource('shipment-route').data), undefined)
  assert.equal(map.getLayer('shipment-stops').paint['circle-stroke-color'], '#24272b')
  assert.equal(map.fits.length, 1)
  map.emit('load')
  assert.equal(map.fits.length, 1)
  overlay.destroy()
})

test('location-only shipment fits its first position once', () => {
  const map = mockMap(), time = clock(), overlay = createShipmentOverlay(map, time)
  map.emit('load')
  overlay.setShipment({ location: { coordinates: [2, 49], at: 1000 } })
  assert.equal(map.fits.length, 1)
  overlay.setShipment({ location: { coordinates: [3, 50], at: 1000 } })
  assert.equal(map.fits.length, 1)
  overlay.destroy()
})
