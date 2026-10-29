import type { MapViewport } from './index.ts'
export interface GeohashCell { readonly geohash: string; readonly coordinates: readonly [number, number]; readonly bounds: readonly [number, number, number, number] }
// Geohash layout reused from Iris Client's src/utils/geohash.ts (MIT, Martti Malmi).
const ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz'
export function decodeGeohash(value: unknown): GeohashCell | null {
  if (typeof value !== 'string' || !/^[0123456789bcdefghjkmnpqrstuvwxyz]{1,12}$/i.test(value)) return null
  const geohash = value.toLowerCase()
  let west = -180, east = 180, south = -90, north = 90, longitude = true
  for (const character of geohash) {
    const bits = ALPHABET.indexOf(character)
    for (let bit = 4; bit >= 0; bit--) {
      if (longitude) { const mid = (west + east) / 2; if (bits & (1 << bit)) west = mid; else east = mid }
      else { const mid = (south + north) / 2; if (bits & (1 << bit)) south = mid; else north = mid }
      longitude = !longitude
    }
  }
  return Object.freeze({ geohash, coordinates: Object.freeze([(west + east) / 2, (south + north) / 2] as const), bounds: Object.freeze([west, south, east, north] as const) })
}

/** A pin describes the published cell's centre, never an inferred street address. */
export function locationFromTags(tags: readonly (readonly string[])[]): GeohashCell | null {
  const cells = tags.filter(tag => tag[0] === 'g').map(tag => decodeGeohash(tag[1])).filter(Boolean)
  cells.sort((a, b) => b.geohash.length - a.geohash.length || a.geohash.localeCompare(b.geohash))
  return cells[0] ?? null
}

const MAX_COVER_CELLS = 32
export const MAX_GEOHASH_QUERY_VALUES = 32768
const MAX_QUERY_PRECISION = 8

function viewportBounds(viewport) {
  if (!viewport || !['west', 'south', 'east', 'north', 'zoom'].every(key => Number.isFinite(viewport[key])) || viewport.south > viewport.north) return null
  const { west, east } = viewport
  const difference = east - west
  const start = ((west + 180) % 360 + 360) % 360 - 180
  const width = Math.abs(difference) >= 360 ? 360 : ((difference % 360) + 360) % 360
  let longitude
  if (width === 360) longitude = [[-180, 180]]
  else if (start + width >= 180) longitude = [[start, 180], [-180, start + width - 360]]
  else {
    longitude = [[start, start + width]]
    // Both encodings of the date-line edge describe the same meridian.
    if (start === -180) longitude.push([180, 180])
  }
  return {
    longitude,
    south: Math.max(-90, Math.min(90, viewport.south)),
    north: Math.max(-90, Math.min(90, viewport.north)),
    zoom: Math.max(0, Math.min(24, viewport.zoom)),
  }
}

function cellGrid(bounds, precision) {
  const longitudeBits = Math.ceil(precision * 5 / 2), latitudeBits = Math.floor(precision * 5 / 2)
  const columns = 2 ** longitudeBits, rows = 2 ** latitudeBits
  const column = value => Math.max(0, Math.min(columns - 1, Math.floor((value + 180) / 360 * columns)))
  const row = value => Math.max(0, Math.min(rows - 1, Math.floor((value + 90) / 180 * rows)))
  const ranges = []
  for (const [west, east] of bounds.longitude.map(([west, east]) => [column(west), column(east)]).sort((a, b) => a[0] - b[0])) {
    const previous = ranges.at(-1)
    if (previous && west <= previous[1] + 1) previous[1] = Math.max(previous[1], east)
    else ranges.push([west, east])
  }
  const south = row(bounds.south), north = row(bounds.north)
  return { ranges, south, north, precision, count: ranges.reduce((sum, [west, east]) => sum + east - west + 1, 0) * (north - south + 1) }
}

function gridHashes(grid) {
  const values = []
  for (const [west, east] of grid.ranges) for (let x = west; x <= east; x++) for (let y = grid.south; y <= grid.north; y++) {
    let longitudeBit = Math.ceil(grid.precision * 5 / 2) - 1
    let latitudeBit = Math.floor(grid.precision * 5 / 2) - 1
    let character = 0, value = ''
    for (let bit = 0; bit < grid.precision * 5; bit++) {
      character = character * 2 + (bit % 2 === 0 ? (x >> longitudeBit--) & 1 : (y >> latitudeBit--) & 1)
      if (bit % 5 === 4) { value += ALPHABET[character]; character = 0 }
    }
    values.push(value)
  }
  return values
}

/**
 * Exact Nostr #g values covering a viewport, never a partial/truncated cover.
 * Start at a zoom-appropriate precision and coarsen until at most 32 cells fit.
 * Include complete finer precision covers within a bounded 32,768-value budget
 * so single-tag listings are found at city/region zooms; an immediate parent
 * is included only at precision 3+ and within four times the base cover's area.
 * Relays match tags exactly. Arbitrary longer single tags remain undiscoverable
 * through this filter; publishers should include their geohash prefixes.
 */
export function geohashQueryForViewport(viewport: MapViewport): string[] {
  const bounds = viewportBounds(viewport)
  if (!bounds) return []
  let precision = Math.max(1, Math.min(MAX_QUERY_PRECISION, Math.ceil((bounds.zoom + 1) / 2.5)))
  let base = cellGrid(bounds, precision)
  while (base.count > MAX_COVER_CELLS && precision > 1) base = cellGrid(bounds, --precision)
  const covers = [base]
  let count = base.count
  if (precision >= 4) {
    const parent = cellGrid(bounds, precision - 1)
    if (parent.count * 32 <= base.count * 4) { covers.push(parent); count += parent.count }
  }
  for (let next = precision + 1; next <= MAX_QUERY_PRECISION; next++) {
    const finer = cellGrid(bounds, next)
    if (count + finer.count > MAX_GEOHASH_QUERY_VALUES) break
    covers.push(finer); count += finer.count
  }
  return covers.flatMap(gridHashes).sort()
}
