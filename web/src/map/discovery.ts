import type { MapViewport } from './index.ts'
import { geohashQueryForViewport } from './geohash.ts'

/** Debounce settled map movement without making map interaction await a relay. */
export function createViewportDiscovery(onQuery: (cells: string[]) => void, { delay = 300, timers = globalThis }: { delay?: number; timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> } = {}) {
  let viewport: MapViewport | null, active = false, disposed = false, timer, lastKey
  function publish() {
    timer = undefined
    if (disposed || !active || !viewport) return
    const cells = geohashQueryForViewport(viewport), key = JSON.stringify(cells)
    if (key !== lastKey) { lastKey = key; onQuery(cells) }
  }
  function schedule() {
    timers.clearTimeout(timer)
    if (!disposed && active && viewport) timer = timers.setTimeout(publish, delay)
  }
  return {
    update(value: MapViewport | null) { viewport = value; schedule() },
    setActive(value: boolean) {
      active = !!value
      if (!active) { timers.clearTimeout(timer); timer = undefined; lastKey = undefined; onQuery([]) }
      else schedule()
    },
    refresh() { lastKey = undefined; schedule() },
    dispose() { disposed = true; timers.clearTimeout(timer); onQuery([]) },
  }
}
