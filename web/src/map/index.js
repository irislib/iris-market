import { assetUrl as browserAssetUrl } from '../asset-url.js'
import * as maplibre from 'maplibre-gl'
import { PMTiles, Protocol, SharedPromiseCache } from 'pmtiles'
import { MapBlockCache } from './cache.js'
import { createPmtilesSource } from './source.js'
import { MAP_ROOT, GLYPH_ROOT, ATTRIBUTION, DEFAULT_CACHE_MIB } from './config.js'
export { CACHE_OPTIONS, DEFAULT_CACHE_MIB } from './config.js'

let sequence = 0
const protocol = new Protocol()
let registered = false
const decoder = new TextDecoder()

export function listingFeatures(listings) {
  return { type: 'FeatureCollection', features: listings.slice(0, 1000).filter(listing => Array.isArray(listing.coordinates) && listing.coordinates.length === 2 && listing.coordinates.every(Number.isFinite) && Math.abs(listing.coordinates[0]) <= 180 && Math.abs(listing.coordinates[1]) <= 90).map(listing => ({
    type: 'Feature', id: listing.id, properties: { id: listing.id, title: listing.title }, geometry: { type: 'Point', coordinates: listing.coordinates },
  })) }
}

/** A style can accept layers before its basemap tiles have finished loading. */
export function createListingOverlay(map, listings = [], dark = false) {
  let ready = false, destroyed = false, currentListings = listings, currentDark = !!dark
  function update() {
    if (!ready || destroyed) return
    const features = listingFeatures(currentListings)
    const source = map.getSource('market-listings')
    if (source) source.setData(features)
    else map.addSource('market-listings', { type: 'geojson', data: features, cluster: true, clusterRadius: 35, clusterMaxZoom: 12 })
    if (!map.getLayer('market-clusters')) map.addLayer({ id: 'market-clusters', type: 'circle', source: 'market-listings', filter: ['has', 'point_count'], paint: { 'circle-color': '#b8e5cf', 'circle-radius': 19, 'circle-stroke-width': 2, 'circle-stroke-color': '#172d2a' } })
    if (!map.getLayer('market-cluster-count')) map.addLayer({ id: 'market-cluster-count', type: 'symbol', source: 'market-listings', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto%20Sans%20Regular'], 'text-size': 12 }, paint: { 'text-color': '#172d2a' } })
    if (!map.getLayer('market-pins')) map.addLayer({ id: 'market-pins', type: 'circle', source: 'market-listings', filter: ['!', ['has', 'point_count']], paint: { 'circle-color': '#65d3a6', 'circle-radius': 9, 'circle-stroke-width': 3, 'circle-stroke-color': currentDark ? '#f7f4eb' : '#172d2a' } })
    else map.setPaintProperty('market-pins', 'circle-stroke-color', currentDark ? '#f7f4eb' : '#172d2a')
  }
  const loaded = () => { ready = true; update() }
  // Do not listen to sourcedata: updating the GeoJSON source emits it again.
  map.on('style.load', loaded)
  map.on('load', loaded)
  return {
    setListings(value) { currentListings = value; update() },
    beginStyleChange(value) { ready = false; currentDark = !!value },
    destroy() { destroyed = true; map.off('style.load', loaded); map.off('load', loaded) },
  }
}

/** Construct only after the user explicitly opens the map. */
export async function createMarketMap(container, { listings = [], dark = false, onSelect = () => {}, onError = () => {}, cacheMiB = DEFAULT_CACHE_MIB } = {}) {
  if (!registered) { maplibre.addProtocol('pmtiles', protocol.tile); registered = true }
  maplibre.setWorkerUrl(browserAssetUrl('maplibre-gl-worker.mjs'))
  maplibre.setWorkerCount(1)
  const scheme = `marketmap${++sequence}`
  const archiveKey = `${scheme}://archive`
  const cache = new MapBlockCache({ cacheMiB })
  const archive = new PMTiles(createPmtilesSource(cache, archiveKey), new SharedPromiseCache(32))
  protocol.add(archive)
  let map, overlay, destroyed = false, fittedListings = false, styleVersion = 0, currentListings = listings, currentDark = !!dark, desiredDark = !!dark
  const lifecycle = new AbortController()
  const report = error => { if (!destroyed && error?.name !== 'AbortError') onError(error instanceof Error ? error : new Error(String(error))) }
  const assetUrl = (root, path) => `${scheme}://${root}/${path}`
  maplibre.addProtocol(scheme, async (request, controller) => {
    const raw = request.url.slice(`${scheme}://`.length)
    const slash = raw.indexOf('/')
    const root = raw.slice(0, slash)
    const path = raw.slice(slash + 1).split('?')[0].split('/').map(decodeURIComponent).join('/')
    const data = await cache.read(root, path, { signal: controller.signal })
    return { data: request.type === 'json' ? JSON.parse(decoder.decode(data)) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }
  })
  async function style(isDark) {
    const data = await cache.read(MAP_ROOT, isDark ? 'ofm/fiord.json' : 'ofm/positron.json', { signal: lifecycle.signal })
    const result = JSON.parse(decoder.decode(data))
    result.glyphs = assetUrl(GLYPH_ROOT, 'ofm/{fontstack}/{range}.pbf')
    result.sprite = assetUrl(MAP_ROOT, 'ofm_f384/ofm')
    // The chosen dataset is the only network source, including fonts and sprites.
    result.sources = { openmaptiles: { type: 'vector', url: `pmtiles://${archiveKey}`, maxzoom: 14, attribution: ATTRIBUTION } }
    result.layers = result.layers.filter(layer => !layer.source || layer.source === 'openmaptiles')
    for (const layer of result.layers) {
      if (layer.layout?.['text-font']) layer.layout['text-font'] = ['Noto%20Sans%20Regular']
      if (layer.paint?.['fill-pattern'] === 'wood-pattern') delete layer.paint['fill-pattern']
    }
    return result
  }
  function fitFirstListings() {
    if (!map || destroyed || fittedListings) return
    const features = listingFeatures(currentListings).features
    if (!features.length) return
    const bounds = new maplibre.LngLatBounds()
    for (const feature of features) bounds.extend(feature.geometry.coordinates)
    map.fitBounds(bounds, { padding: 50, maxZoom: 11, duration: 0 })
    fittedListings = true
  }
  async function destroy() {
    if (destroyed) return
    destroyed = true; lifecycle.abort(); overlay?.destroy(); map?.remove(); maplibre.removeProtocol(scheme); protocol.tiles.delete(archiveKey)
    await cache.close()
  }
  try {
    const initialStyle = await style(currentDark)
    if (destroyed) throw new Error('Map closed')
    map = new maplibre.Map({ container, style: initialStyle, center: [24.94, 60.17], zoom: 4, minZoom: 0, maxZoom: 18, attributionControl: { compact: true }, maxTileCacheSize: 64, fadeDuration: 0, renderWorldCopies: false })
    map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right')
    map.on('error', event => report(event.error))
    overlay = createListingOverlay(map, currentListings, currentDark)
    map.on('click', 'market-pins', event => {
      const id = event.features?.[0]?.properties?.id
      const listing = currentListings.find(item => item.id === id)
      if (listing) onSelect(listing)
    })
    map.on('click', 'market-clusters', async event => {
      const feature = event.features?.[0]
      if (!feature) return
      try { const zoom = await map.getSource('market-listings').getClusterExpansionZoom(feature.properties.cluster_id); if (!destroyed) map.easeTo({ center: feature.geometry.coordinates, zoom }) }
      catch (error) { report(error) }
    })
    for (const layer of ['market-pins', 'market-clusters']) {
      map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = '' })
    }
    fitFirstListings()
    await Promise.race([map.once('load'), new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('Map loading timed out')), 35000); map.once('load').then(() => clearTimeout(timeout)); lifecycle.signal.addEventListener('abort', () => { clearTimeout(timeout); reject(new DOMException('Map closed', 'AbortError')) }, { once: true }) })])
    return {
      setListings(value) { currentListings = value; fitFirstListings(); overlay.setListings(value) },
      async setDark(value) {
        const nextDark = !!value
        if (nextDark === desiredDark) return
        desiredDark = nextDark; const version = ++styleVersion
        try {
          const next = await style(nextDark)
          if (!destroyed && version === styleVersion) { currentDark = nextDark; overlay.beginStyleChange(nextDark); map.setStyle(next) }
        } catch (error) { if (version === styleVersion) desiredDark = currentDark; report(error); throw error }
      },
      getStorageStats: () => cache.getStorageStats(),
      setCacheMiB: value => cache.setCacheMiB(value),
      async clearCache() { const stats = await cache.clearCache(); archive.cache.cache.clear(); return stats },
      resize: () => map.resize(),
      destroy,
    }
  } catch (error) { await destroy(); throw error }
}
