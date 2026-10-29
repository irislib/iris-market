// Dataset and paths reused from Iris Maps src/lib/mapBasemap.ts, MIT.
// Immutable roots prevent PMTiles ranges from mixing archive revisions.
export const MAP_ROOT = 'nhash1qqs92rt6kceh2c6avycdtuz7hq85cwe4qtpda4nnc6hlqea7qr7q37q9ypjd69kurnrr30phtdzmr55kv3sglk0ygqmxae8qulprprr054hmvf6mefu'
// The working basemap tree includes its own font ranges. The separate legacy
// glyph tree is unavailable on the public CDN, so keep glyphs on this pinned root.
export const GLYPH_ROOT = MAP_ROOT
export const BLOB_SERVER = 'https://cdn.iris.to'
export const CACHE_OPTIONS = Object.freeze([64, 128, 256, 512])
export const DEFAULT_CACHE_MIB = 128
export const ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> · <a href="https://openfreemap.org">OpenFreeMap</a> · <a href="https://openmaptiles.org">OpenMapTiles</a> · Hashtree'
export const DATABASE_NAME = 'iris-market-hashtree-public-v1'
export function cacheBytes(mib) {
  if (!CACHE_OPTIONS.includes(mib)) throw new Error('Choose 64, 128, 256 or 512 MiB')
  return mib * 1024 * 1024
}
export function validatePath(root, path) {
  if (![MAP_ROOT, GLYPH_ROOT].includes(root) || typeof path !== 'string' || path.length > 512 || path.split('/').some(s => !s || s === '.' || s === '..')) throw new Error('Invalid map asset')
  return path
}
