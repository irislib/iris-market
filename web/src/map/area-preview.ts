import type {MapOverlay} from './index.ts'

const SOURCE = 'public-area-preview'
export type Bounds = readonly [number, number, number, number]

/** The public area as map features: its outline, and the point only for an exact place. */
export function areaFeatures(bounds: Bounds, point?: readonly [number, number] | null) {
  const [west, south, east, north] = bounds
  return {type: 'FeatureCollection', features: [
    {type: 'Feature', properties: {kind: 'area'}, geometry: {type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]}},
    ...(point ? [{type: 'Feature', properties: {kind: 'point'}, geometry: {type: 'Point', coordinates: [...point]}}] : []),
  ]}
}

/** A small read-only map of what a listing makes public. Only public basemap blocks are fetched. */
export async function createAreaPreview(container: HTMLElement, {bounds, point = null, dark = false}: {bounds: Bounds; point?: readonly [number, number] | null; dark?: boolean}) {
  const {createMarketMap} = await import('./index.ts')
  return createMarketMap(container, {dark, createOverlay: (map, appearance): MapOverlay => {
    let destroyed = false, currentDark = appearance
    map.getCanvas?.()?.setAttribute('aria-label', point ? 'Map of the exact place people will see' : 'Map of the area people will see')
    const draw = () => {
      if (destroyed) return
      const data = areaFeatures(bounds, point), source = map.getSource(SOURCE) as {setData?: (value: unknown) => void} | undefined
      if (source?.setData) source.setData(data); else map.addSource(SOURCE, {type: 'geojson', data} as never)
      const color = currentDark ? '#9cc3ff' : '#2f6fd6'
      const layers = [
        {id: `${SOURCE}-fill`, type: 'fill', source: SOURCE, filter: ['==', ['get', 'kind'], 'area'], paint: {'fill-color': color, 'fill-opacity': point ? 0.06 : 0.16}},
        {id: `${SOURCE}-line`, type: 'line', source: SOURCE, filter: ['==', ['get', 'kind'], 'area'], paint: {'line-color': color, 'line-width': 2}},
        {id: `${SOURCE}-point`, type: 'circle', source: SOURCE, filter: ['==', ['get', 'kind'], 'point'], paint: {'circle-color': color, 'circle-radius': 7, 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff'}},
      ]
      for (const layer of layers) if (!map.getLayer(layer.id)) map.addLayer(layer as never)
      map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], {padding: 24, maxZoom: point ? 14 : 12, duration: 0})
    }
    map.on('style.load', draw); map.on('load', draw)
    return {
      beginStyleChange(value) { currentDark = value },
      destroy() { destroyed = true; map.off('style.load', draw); map.off('load', draw) },
    }
  }})
}
