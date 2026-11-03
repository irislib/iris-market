import { decodeGeohash, encodeLocationHash, locationHash } from './geohash.ts'

const pair = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/
export function coordinatePair(text: string): [longitude: number, latitude: number] | null {
  if (text.length > 80) return null
  const match = pair.exec(text.trim())
  if (!match) return null
  const lat = Number(match[1]), lng = Number(match[2])
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lng, lat] : null
}

export function listingPin(input: string, precision: string) {
  if (!input.trim()) return null
  const existing = locationHash(input)
  const length = precision === 'exact' ? 12 : Number(precision)
  if (!Number.isInteger(length) || length < 1 || length > 12) throw Error('Choose a map precision.')
  if (existing && precision !== 'exact') return {hash: existing.slice(0, length), uri: null}
  const point = coordinatePair(input)
  if (!point) throw Error('Enter latitude, longitude or use your location for this pin.')
  const [lng, lat] = point
  const components = input.trim().split(/\s*,\s*/).map(part => part.replace(/^\+/, '').replace(/^(-?)\./, (_, sign) => sign + '0.').replace(/\.$/, ''))
  return {hash: encodeLocationHash(lng, lat, length), uri: precision === 'exact' ? 'geo:' + components.join(',') : null}
}

/** A signed geo URI supplies the exact point only when the precise public cell agrees. */
export function exactListingPoint(tags: readonly (readonly string[])[], hash: string | null): [number, number] | null {
  if (hash?.length !== 12) return null
  const locations = tags.filter(tag => tag[0] === 'r' && tag[1]?.startsWith('geo:'))
  if (locations.length !== 1) return null
  const point = coordinatePair(locations[0][1].slice(4))
  return point && encodeLocationHash(...point, 12) === hash ? point : null
}

export function pinPreview(tags: readonly (readonly string[])[], hash: string): string {
  const point = exactListingPoint(tags, hash)
  if (point) return 'Public pin · ' + point[1] + ', ' + point[0]
  const bounds = decodeGeohash(hash)!.bounds
  const heightKm = (bounds[3] - bounds[1]) * 111.2
  const widthKm = (bounds[2] - bounds[0]) * 111.2 * Math.cos((bounds[1] + bounds[3]) * Math.PI / 360)
  const metres = Math.max(widthKm, heightKm) < 1
  const size = (km: number) => Number((metres ? km * 1000 : km).toPrecision(2))
  return 'Public area · #' + hash + ' · about ' + size(widthKm) + ' × ' + size(heightKm) + (metres ? ' m' : ' km')
}
