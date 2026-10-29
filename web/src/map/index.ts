import { assetUrl as browserAssetUrl } from '../asset-url.ts'
import * as maplibre from 'maplibre-gl'
import { PMTiles, Protocol, SharedPromiseCache } from 'pmtiles'
import { MapBlockCache } from './cache.ts'
import { createPmtilesSource } from './source.ts'
import { MAP_ROOT, GLYPH_ROOT, ATTRIBUTION, DEFAULT_CACHE_MIB } from './config.ts'
export { CACHE_OPTIONS, DEFAULT_CACHE_MIB } from './config.ts'

export interface MapListing { id: string; title: string; coordinates?: readonly number[] }
export interface MapViewport { west: number; south: number; east: number; north: number; zoom: number }
export interface MapOverlay { setListings?(value: MapListing[]): void; beginStyleChange(dark: boolean): void; destroy(): void }
export interface ListingInteractionOptions {
  getListings?: () => MapListing[]
  onSelect?: (listing: MapListing) => void
  onError?: (error: Error) => void
  createPopup?: () => maplibre.Popup
  document?: Document
}
export interface MarketMapOptions {
  listings?: MapListing[]; dark?: boolean; onSelect?: (listing: MapListing) => void
  onError?: (error: Error) => void; onViewport?: (viewport: MapViewport) => void; cacheMiB?: number
  createOverlay?: (map: maplibre.Map, dark: boolean) => MapOverlay
}

let sequence = 0
const protocol = new Protocol()
let registered = false
const decoder = new TextDecoder()

export function listingFeatures(listings: MapListing[]) {
  const seen = new Set<string>()
  return { type: 'FeatureCollection', features: listings.slice(0, 1000).filter(listing => {
    if (seen.has(listing.id) || !Array.isArray(listing.coordinates) || listing.coordinates.length !== 2 || !listing.coordinates.every(Number.isFinite) || Math.abs(listing.coordinates[0]) > 180 || Math.abs(listing.coordinates[1]) > 90) return false
    seen.add(listing.id); return true
  }).map(listing => ({
    type: 'Feature', id: listing.id, properties: { id: listing.id, title: listing.title }, geometry: { type: 'Point', coordinates: listing.coordinates },
  })) }
}

/** A style can accept layers before its basemap tiles have finished loading. */
export function createListingOverlay(map, listings: MapListing[] = [], dark = false) {
  let ready = false, destroyed = false, currentListings = listings, currentDark = !!dark, featureKey
  function update() {
    if (!ready || destroyed) return
    const features = listingFeatures(currentListings)
    const source = map.getSource('market-listings')
    const nextKey = JSON.stringify(features)
    if (source) { if (nextKey !== featureKey) source.setData(features) }
    // Vector-tile IDs are integers. Promote the canonical string property so
    // author:identifier values survive encoding without numeric-prefix collisions.
    // MapLibre retains generated cluster_id as the cluster's feature-state key.
    else map.addSource('market-listings', { type: 'geojson', data: features, promoteId: 'id', cluster: true, clusterRadius: 35, clusterMaxZoom: 12 })
    featureKey = nextKey
    if (!map.getLayer('market-clusters')) map.addLayer({ id: 'market-clusters', type: 'circle', source: 'market-listings', filter: ['has', 'point_count'], paint: { 'circle-color': '#b8e5cf', 'circle-radius': ['case', ['boolean', ['feature-state', 'hover'], false], 21.3, 19], 'circle-radius-transition': { duration: 100, delay: 0 }, 'circle-stroke-width': 2, 'circle-stroke-color': '#172d2a' } })
    if (!map.getLayer('market-cluster-count')) map.addLayer({ id: 'market-cluster-count', type: 'symbol', source: 'market-listings', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto%20Sans%20Regular'], 'text-size': 12 }, paint: { 'text-color': '#172d2a' } })
    if (!map.getLayer('market-pins')) map.addLayer({ id: 'market-pins', type: 'circle', source: 'market-listings', filter: ['!', ['has', 'point_count']], paint: { 'circle-color': '#65d3a6', 'circle-radius': ['case', ['boolean', ['feature-state', 'hover'], false], 10.2, 9], 'circle-radius-transition': { duration: 100, delay: 0 }, 'circle-stroke-width': 3, 'circle-stroke-color': currentDark ? '#f7f4eb' : '#172d2a' } })
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

const HIT_LAYERS = ['market-cluster-count', 'market-clusters', 'market-pins']

export function mapViewport(map: maplibre.Map): MapViewport | null {
  const bounds = map.getBounds()
  const viewport = { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth(), zoom: map.getZoom() }
  return Object.values(viewport).every(Number.isFinite) ? viewport : null
}

/** One hit test covers both the cluster label and circle without duplicate actions. */
export function createListingInteractions(map, { getListings, onSelect, onError = () => {}, createPopup = () => new maplibre.Popup({ className: 'market-map-popup', maxWidth: '300px', focusAfterOpen: true, closeOnClick: false, closeButton: false }), document: doc = globalThis.document }: ListingInteractionOptions = {}) {
  let destroyed = false, revision = 0, popup, popupContent:HTMLElement|undefined
  let hovered: string | number | undefined
  const canvas = map.getCanvas()
  const previousLabel = canvas.getAttribute('aria-label')
  canvas.setAttribute('aria-label', 'Listing map. Use arrow keys to pan. Press Enter to browse visible listings.')
  const hits = point => {
    const layers = HIT_LAYERS.filter(id => map.getLayer(id))
    return layers.length ? map.queryRenderedFeatures(point, { layers }) : []
  }
  const resolve = features => {
    const ids = new Set(features.map(feature => feature.properties?.id))
    return getListings().filter(listing => ids.has(listing.id))
  }
  const close = (restoreFocus=false) => { const opened=!!popup;popup?.remove();popup=undefined;popupContent=undefined;if(opened&&restoreFocus)canvas.focus({preventScroll:true}) }
  function choose(listings, coordinates) {
    if (destroyed || !listings.length) return
    close()
    const content = doc.createElement('section'), heading = doc.createElement('h3'), choices = doc.createElement('div')
    content.setAttribute('role','dialog');content.setAttribute('aria-label','Choose a listing')
    heading.textContent = `${listings.length} ${listings.length===1?'listing':'listings'}`
    choices.className = 'market-map-choices'
    choices.setAttribute('aria-label', 'Choose a listing')
    for (const listing of listings) {
      const button = doc.createElement('button')
      button.type = 'button'; button.textContent = listing.title || 'View listing'
      button.onclick = () => { close(); onSelect(listing) }
      choices.append(button)
    }
    const dismiss=doc.createElement('button')
    dismiss.type='button';dismiss.className='maplibregl-popup-close-button';dismiss.textContent='×';dismiss.setAttribute('aria-label','Close listing choices');dismiss.onclick=()=>close(true)
    content.append(heading, choices, dismiss);popupContent=content
    content.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(true) } })
    popup = createPopup().setLngLat(coordinates).setDOMContent(content).addTo(map);
    (choices.firstElementChild as HTMLElement)?.focus({ preventScroll: true })
  }
  async function activate(event) {
    const ticket = ++revision, features = hits(event.point)
    if (!features.length) { close();return }
    const cluster = features.find(feature => feature.properties?.cluster_id !== undefined)
    if (!cluster) { choose(resolve(features), features[0].geometry.coordinates); return }
    const source = map.getSource('market-listings'), id = cluster.properties.cluster_id
    if (!source) return
    try {
      // Leaves allow an immediate choice when zooming cannot separate co-located offers.
      const [zoom, leaves] = await Promise.all([source.getClusterExpansionZoom(id), source.getClusterLeaves(id, 1000, 0)])
      if (destroyed || ticket !== revision || source !== map.getSource('market-listings')) return
      const listings = resolve(leaves), coordinates = cluster.geometry.coordinates
      const sameLocation = leaves.length > 1 && leaves.every(leaf => leaf.geometry.coordinates.every((value, index) => Math.abs(value - leaves[0].geometry.coordinates[index]) < 1e-7))
      const targetZoom = Math.min(zoom, map.getMaxZoom())
      if (sameLocation || !Number.isFinite(targetZoom) || targetZoom <= map.getZoom() + 0.01) choose(listings, coordinates)
      else { close(); map.easeTo({ center: coordinates, zoom: targetZoom }) }
    } catch (error) { if (!destroyed && ticket === revision) onError(error) }
  }
  const click = event => { void activate(event) }
  const setHover = (id?: string | number) => {
    if (id === hovered) return
    // A style/source can disappear between the pointer event and this update.
    try {
      if (!map.getSource('market-listings')) { hovered = undefined; return }
      if (hovered !== undefined) map.setFeatureState({ source: 'market-listings', id: hovered }, { hover: false })
      if (id !== undefined) map.setFeatureState({ source: 'market-listings', id }, { hover: true })
      hovered = id
    } catch { hovered = undefined /* Retry the next pointer event after a style change. */ }
  }
  const move = event => {
    const feature = hits(event.point)[0]
    canvas.style.cursor = feature ? 'pointer' : ''
    const id = feature?.properties?.cluster_id ?? feature?.properties?.id
    setHover(typeof id === 'string' || typeof id === 'number' && Number.isFinite(id) ? id : undefined)
  }
  const leave = () => { setHover(); canvas.style.cursor = '' }
  const keydown = event => {
    if (event.target !== canvas || !['Enter', ' '].includes(event.key)) return
    event.preventDefault(); revision++
    const bounds = map.getBounds()
    const listings = getListings().filter(listing => listing.coordinates && bounds.contains(listing.coordinates)).slice(0, 1000)
    choose(listings, map.getCenter())
  }
  const inside=target=>!!target&&!!popupContent?.contains(target)
  const outside=event=>{if(!inside(event.target)){revision++;close()}}
  const focusOutside=event=>{if(popup&&!inside(event.target))close()}
  const escape=event=>{if(popup&&event.key==='Escape'){event.preventDefault();event.stopPropagation();revision++;close(true)}}
  map.on('click', click); map.on('mousemove', move); map.on('style.load', leave); map.on('movestart', leave)
  canvas.addEventListener('mouseleave', leave); canvas.addEventListener('keydown', keydown)
  doc.addEventListener('pointerdown',outside);doc.addEventListener('focusin',focusOutside);doc.addEventListener('keydown',escape)
  return {
    invalidate() { revision++; close(); leave() },
    destroy() {
      destroyed = true; revision++; close(); leave(); map.off('click', click); map.off('mousemove', move); map.off('style.load', leave); map.off('movestart', leave)
      canvas.removeEventListener('mouseleave', leave); canvas.removeEventListener('keydown', keydown); canvas.style.cursor = ''
      doc.removeEventListener('pointerdown',outside);doc.removeEventListener('focusin',focusOutside);doc.removeEventListener('keydown',escape)
      if (previousLabel === null) canvas.removeAttribute('aria-label'); else canvas.setAttribute('aria-label', previousLabel)
    },
  }
}

/** Construct only after the user explicitly opens the map. */
export async function createMarketMap(container, { listings = [], dark = false, onSelect = () => {}, onError = () => {}, onViewport = () => {}, cacheMiB = DEFAULT_CACHE_MIB, createOverlay }: MarketMapOptions = {}) {
  if (!registered) { maplibre.addProtocol('pmtiles', protocol.tile); registered = true }
  maplibre.setWorkerUrl(browserAssetUrl('maplibre-gl-worker.mjs'))
  maplibre.setWorkerCount(1)
  const scheme = `marketmap${++sequence}`
  const archiveKey = `${scheme}://archive`
  const cache = new MapBlockCache({ cacheMiB })
  const archiveCache = new SharedPromiseCache(32)
  const archive = new PMTiles(createPmtilesSource(cache, archiveKey), archiveCache)
  protocol.add(archive)
  let map, overlay, interactions, destroyed = false, fittedListings = false, styleVersion = 0, currentListings = listings, currentDark = !!dark, desiredDark = !!dark
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
    for (const feature of features) bounds.extend([feature.geometry.coordinates[0], feature.geometry.coordinates[1]])
    map.fitBounds(bounds, { padding: 50, maxZoom: 11, duration: 0 })
    fittedListings = true
  }
  async function destroy() {
    if (destroyed) return
    destroyed = true; lifecycle.abort(); interactions?.destroy(); overlay?.destroy(); map?.remove(); maplibre.removeProtocol(scheme); protocol.tiles.delete(archiveKey)
    await cache.close()
  }
  try {
    const initialStyle = await style(currentDark)
    if (destroyed) throw new Error('Map closed')
    map = new maplibre.Map({ container, style: initialStyle, center: [24.94, 60.17], zoom: 4, minZoom: 0, maxZoom: 18, attributionControl: { compact: true }, maxTileCacheSize: 64, fadeDuration: 0, renderWorldCopies: false })
    map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right')
    map.on('error', event => report(event.error))
    // Private overlays share only the basemap/cache lifecycle, never listing discovery or interactions.
    overlay = createOverlay ? createOverlay(map, currentDark) : createListingOverlay(map, currentListings, currentDark)
    if (!createOverlay) interactions = createListingInteractions(map, { getListings: () => currentListings, onSelect, onError: report })
    const reportViewport = () => { const viewport = mapViewport(map); if (!destroyed && viewport) onViewport(viewport) }
    map.on('moveend', reportViewport)
    fitFirstListings()
    await Promise.race([map.once('load'), new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('Map loading timed out')), 35000); map.once('load').then(() => clearTimeout(timeout)); lifecycle.signal.addEventListener('abort', () => { clearTimeout(timeout); reject(new DOMException('Map closed', 'AbortError')) }, { once: true }) })])
    reportViewport()
    return {
      viewport: () => mapViewport(map),
      setListings(value) {
        const changed = JSON.stringify(listingFeatures(value)) !== JSON.stringify(listingFeatures(currentListings))
        currentListings = value; if (changed) interactions?.invalidate(); fitFirstListings(); overlay.setListings?.(value)
      },
      async setDark(value) {
        const nextDark = !!value
        if (nextDark === desiredDark) return
        desiredDark = nextDark; const version = ++styleVersion
        try {
          const next = await style(nextDark)
          if (!destroyed && version === styleVersion) { currentDark = nextDark; interactions?.invalidate(); overlay.beginStyleChange(nextDark); map.setStyle(next) }
        } catch (error) { if (version === styleVersion) desiredDark = currentDark; report(error); throw error }
      },
      getStorageStats: () => cache.getStorageStats(),
      setCacheMiB: value => cache.setCacheMiB(value),
      async clearCache() { const stats = await cache.clearCache(); archiveCache.cache.clear(); return stats },
      resize: () => map.resize(),
      destroy,
    }
  } catch (error) { await destroy(); throw error }
}
