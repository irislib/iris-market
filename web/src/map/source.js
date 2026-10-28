import { MAP_ROOT } from './config.js'

/** PMTiles fetches only directory/tile ranges; never load the complete archive. */
export function createPmtilesSource(cache, key) {
  return {
    getKey: () => key,
    async getBytes(offset, length, signal) {
      const data = await cache.read(MAP_ROOT, 'tiles.pmtiles', { start: offset, length, signal })
      return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), etag: MAP_ROOT, cacheControl: 'public, max-age=31536000, immutable' }
    },
  }
}
