import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeGeohash, geohashQueryForViewport } from '../src/map/geohash.ts'

const alphabet = '0123456789bcdefghjkmnpqrstuvwxyz'
const helsinki = { west: 24.75, south: 60.1, east: 25.15, north: 60.3, zoom: 11 }
function covers(values, longitude, latitude) {
  return values.some(value => {
    const [west, south, east, north] = decodeGeohash(value).bounds
    return latitude >= south && latitude <= north && longitude >= west && longitude <= east
  })
}
function assertBounded(values) {
  assert(values.length > 0 && values.length <= 2048)
  assert.deepEqual(values, [...new Set(values)].sort())
  for (const value of values) assert.match(value, /^[0123456789bcdefghjkmnpqrstuvwxyz]{1,8}$/)
}

test('world view covers every top-level cell without an unbounded query', () => {
  const values = geohashQueryForViewport({ west: -180, south: -90, east: 180, north: 90, zoom: 0 })
  assert.deepEqual(values.filter(value => value.length === 1), [...alphabet])
  assert.equal(values.filter(value => value.length === 2).length, 1024)
  assert.deepEqual(geohashQueryForViewport({ west: -540, south: -100, east: 540, north: 100, zoom: 24 }), values)
})

test('city queries cover viewport corners and interior without continent tags', () => {
  const values = geohashQueryForViewport(helsinki)
  assertBounded(values)
  assert(values.every(value => value.length >= 3))
  for (const longitude of [24.75, 24.9, 25.15]) for (const latitude of [60.1, 60.2, 60.3]) assert(covers(values, longitude, latitude))
  assert.deepEqual(geohashQueryForViewport({ ...helsinki }), values)
})

test('crossing and unwrapped antimeridian viewports return the same complete coverage', () => {
  const viewport = { west: 179.6, south: -17.9, east: -179.4, north: -17.5, zoom: 10 }
  const values = geohashQueryForViewport(viewport)
  assertBounded(values)
  assert.deepEqual(geohashQueryForViewport({ ...viewport, east: 180.6 }), values)
  assert.deepEqual(geohashQueryForViewport({ ...viewport, west: -180.4, east: -179.4 }), values)
  for (const longitude of [179.6, 179.9, 180, -180, -179.8, -179.4]) for (const latitude of [-17.9, -17.7, -17.5]) assert(covers(values, longitude, latitude))
  assert(!covers(values, 0, -17.7))
})

test('polar and narrow viewports remain finite and completely covered', () => {
  for (const viewport of [
    { west: -180, south: 89.9, east: 180, north: 90, zoom: 20 },
    { west: -180, south: -90, east: 180, north: -89.9, zoom: 20 },
    { west: 24.9, south: -90, east: 24.900001, north: 90, zoom: 24 },
    { west: 24.9, south: 60.17, east: 24.900001, north: 60.170001, zoom: 24 },
  ]) {
    const values = geohashQueryForViewport(viewport)
    assertBounded(values)
    for (const longitude of [viewport.west, (viewport.west + viewport.east) / 2, viewport.east]) for (const latitude of [viewport.south, (viewport.south + viewport.north) / 2, viewport.north]) assert(covers(values, longitude, latitude))
  }
})

test('zero-area cell boundaries and both antimeridian spellings are covered', () => {
  for (const point of [[0, 0], [-180, 90], [180, -90], [24.94, 60.17]]) {
    const values = geohashQueryForViewport({ west: point[0], east: point[0], south: point[1], north: point[1], zoom: 24 })
    assertBounded(values)
    assert(covers(values, ...point))
    if (Math.abs(point[0]) === 180) assert(covers(values, -point[0], point[1]))
    assert(values.every(value => value.length >= 8), 'a point query must not add a much broader parent')
  }
})

test('invalid viewports do not start geographical discovery', () => {
  for (const viewport of [undefined, null, {}, { ...helsinki, zoom: NaN }, { ...helsinki, north: Infinity }, { ...helsinki, west: '24' }, { ...helsinki, south: 61, north: 60 }]) assert.deepEqual(geohashQueryForViewport(viewport), [])
})

test('adjacent precision is complete and parent cells never expand area more than fourfold', () => {
  const viewport = { west: 24.7, south: 60.1, east: 25.1, north: 60.3, zoom: 12 }
  const values = geohashQueryForViewport(viewport)
  assertBounded(values)
  const precisions = [...new Set(values.map(value => value.length))].sort()
  assert(precisions.length >= 2)
  assert(precisions.length <= 8)
  for (const precision of precisions) {
    const group = values.filter(value => value.length === precision)
    for (const longitude of [24.7, 24.9, 25.1]) for (const latitude of [60.1, 60.2, 60.3]) assert(covers(group, longitude, latitude))
  }
  // The widest group is an optional immediate parent of a <=32-cell base.
  const widest = values.filter(value => value.length === precisions[0])
  const next = values.filter(value => value.length === precisions[0] + 1)
  if (next.length <= 32) assert(widest.length * 32 <= next.length * 4)
})

test('bounded deterministic covers remain complete across varied viewport shapes and zooms', () => {
  let random = 7831
  const unit = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 2 ** 32 }
  for (let i = 0; i < 250; i++) {
    const west = unit() * 720 - 360, width = 360 * unit() ** 5
    const south = unit() * 180 - 90, north = Math.min(90, south + 180 * unit() ** 5)
    const values = geohashQueryForViewport({ west, south, east: west + width, north, zoom: unit() * 24 })
    assertBounded(values)
    for (const x of [0, .5, 1]) for (const y of [0, .5, 1]) {
      const longitude = ((west + x * width + 180) % 360 + 360) % 360 - 180
      assert(covers(values, longitude, south + y * (north - south)), `uncovered viewport ${i}`)
    }
  }
})

// Relays compare exact tag strings: geometric coverage by a parent is not enough.
test('city viewport includes precise single-tag listings without requiring publishers to add prefixes', () => {
  const values = geohashQueryForViewport(helsinki)
  assert(values.includes('ud9wr2'), 'Helsinki precision-6 listing must be requested at city zoom')
  assertBounded(values)
  assert(!values.includes('u'), 'do not broaden a city search to a continent')
})
