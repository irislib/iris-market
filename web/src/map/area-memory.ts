import {decodeGeohash, encodeLocationHash} from './geohash.ts'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>
const KEEP = 4

/** The cells around a geohash cell, at the same length. */
export function neighbourCells(hash: string): string[] {
  const cell = decodeGeohash(hash)
  if (!cell) return []
  const [west, south, east, north] = cell.bounds, [lng, lat] = cell.coordinates
  const width = east - west, height = north - south, cells = new Set<string>()
  for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) {
    const y = lat + dy * height
    if ((dx || dy) && Math.abs(y) < 90) cells.add(encodeLocationHash(((lng + dx * width + 540) % 360) - 180, y, cell.geohash.length))
  }
  cells.delete(cell.geohash)
  return [...cells]
}

/**
 * Reuses a remembered area when the new one is the same or next to it, so listings
 * posted from either side of a cell border do not reveal that border.
 */
export function stickyArea(hash: string, remembered: readonly string[]): string {
  return remembered.find(area => area.length === hash.length && (area === hash || neighbourCells(area).includes(hash))) ?? hash
}

/** Recent public areas of one profile; kept only in this browser. */
export function createAreaMemory(storage: Storage | undefined = globalThis.localStorage, owner = () => '') {
  const key = () => `market-areas-v1/${owner() || 'guest'}`
  const areas = (): string[] => {
    try { const value = JSON.parse(storage?.getItem(key()) ?? '[]'); return Array.isArray(value) ? value.filter(area => typeof area === 'string' && decodeGeohash(area)?.geohash === area).slice(0, KEEP) : [] }
    catch { return [] }
  }
  return {
    areas,
    remember(hash: string) {
      if (decodeGeohash(hash)?.geohash !== hash) return
      try { storage?.setItem(key(), JSON.stringify([hash, ...areas().filter(area => area !== hash)].slice(0, KEEP))) } catch { /* A blocked store only loses the memory. */ }
    },
  }
}
