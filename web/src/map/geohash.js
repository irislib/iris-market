// Geohash layout reused from Iris Client's src/utils/geohash.ts (MIT, Martti Malmi).
const ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz'
export function decodeGeohash(value) {
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
  return Object.freeze({ geohash, coordinates: Object.freeze([(west + east) / 2, (south + north) / 2]), bounds: Object.freeze([west, south, east, north]) })
}

/** A pin describes the published cell's centre, never an inferred street address. */
export function locationFromTags(tags) {
  const cells = tags.filter(tag => tag[0] === 'g').map(tag => decodeGeohash(tag[1])).filter(Boolean)
  cells.sort((a, b) => b.geohash.length - a.geohash.length || a.geohash.localeCompare(b.geohash))
  return cells[0] ?? null
}
