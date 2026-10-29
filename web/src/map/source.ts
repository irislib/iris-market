import type { Source } from 'pmtiles'
import type { MapBlockCache } from './cache.ts'
import { MAP_ROOT } from './config.ts'

/** PMTiles fetches only directory/tile ranges; never load the complete archive. */
export function createPmtilesSource(cache: Pick<MapBlockCache, 'read'>, key: string): Source {
  return {
    getKey: () => key,
    async getBytes(offset, length, signal) {
      const data = await cache.read(MAP_ROOT, 'tiles.pmtiles', { start: offset, length, signal })
      return { data: new Uint8Array(data).buffer, etag: MAP_ROOT, cacheControl: 'public, max-age=31536000, immutable' }
    },
  }
}
