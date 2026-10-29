import { createMarketMap } from './index.ts'

export interface ShipmentStop { id?: string; label?: string; address?: string; coordinates?: readonly number[]; status?: string; courierPubkey?: string }
export interface Shipment { stops?: ShipmentStop[]; location?: { coordinates?: readonly number[]; at: number; courierPubkey?: string; stopId?: string } }
export interface ShipmentMapOptions { dark?: boolean; onError?: (error: Error) => void }

const SOURCE = 'shipment-route'
const MAX_STOPS = 12
export const COURIER_LOCATION_MAX_AGE_SECONDS = 120
const validCoordinates = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90
const feature = (id, properties, geometry) => ({ type: 'Feature', id, properties, geometry })
const point = (id, properties, coordinates) => feature(id, properties, { type: 'Point', coordinates: [...coordinates] })

function stopsFor(shipment) {
  return (Array.isArray(shipment?.stops) ? shipment.stops : []).slice(0, MAX_STOPS).map((stop, index) => ({
    id: typeof stop?.id === 'string' ? stop.id.slice(0, 160) : String(index),
    label: typeof stop?.label === 'string' ? stop.label.slice(0, 160) : '',
    status: ['pending', 'arrived', 'completed'].includes(stop?.status) ? stop.status : 'pending',
    coordinates: validCoordinates(stop?.coordinates) ? [...stop.coordinates] : null,
  }))
}

function freshLocation(shipment, now) {
  const location = shipment?.location
  if (!location || !validCoordinates(location.coordinates) || !Number.isFinite(now) || !Number.isSafeInteger(location.at) || location.at < 0) return null
  const age = now - location.at
  return age >= 0 && age < COURIER_LOCATION_MAX_AGE_SECONDS ? location : null
}

// Split a direct itinerary leg at the date line instead of drawing across the world.
function itineraryLeg(start, end) {
  let longitude = end[0]
  if (longitude - start[0] > 180) longitude -= 360
  else if (longitude - start[0] < -180) longitude += 360
  if (longitude >= -180 && longitude <= 180) return { type: 'LineString', coordinates: [[...start], [longitude, end[1]]] }
  const edge = longitude > 180 ? 180 : -180
  const latitude = start[1] + (end[1] - start[1]) * ((edge - start[0]) / (longitude - start[0]))
  return { type: 'MultiLineString', coordinates: [[[...start], [edge, latitude]], [[-edge, latitude], [...end]]] }
}

/** Pure display projection; the order reducer owns participant authorization. */
export function shipmentFeatures(shipment: Shipment, now = Date.now() / 1000) {
  const stops = stopsFor(shipment), features = []
  const arrived = stops.findIndex(stop => stop.status === 'arrived')
  const current = arrived >= 0 ? arrived : stops.findIndex(stop => stop.status !== 'completed')
  for (let index = 0; index < stops.length; index++) {
    const stop = stops[index]
    if (!stop.coordinates) continue
    if (index > 0 && stops[index - 1].coordinates) features.push(feature(`leg-${index}`, { kind: 'leg' }, itineraryLeg(stops[index - 1].coordinates, stop.coordinates)))
    features.push(point(`stop-${index}`, { kind: 'stop', stopId: stop.id, label: stop.label, number: index + 1, status: stop.status, current: index === current }, stop.coordinates))
  }
  const location = freshLocation(shipment, now)
  if (location) features.push(point('courier', { kind: 'courier' }, location.coordinates))
  return { type: 'FeatureCollection', features }
}

/** Route geometry is private local state; it is never sent to a relay or geocoder. */
export function createShipmentOverlay(map, { dark = false, now = () => Date.now() / 1000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let ready = false, destroyed = false, shipment = null, currentDark = !!dark, featureKey, routeKey, fittedRouteKey, timer
  const canvas = map.getCanvas?.(), previousLabel = canvas?.getAttribute('aria-label')
  canvas?.setAttribute('aria-label', 'Delivery map. Numbered stops are joined directly, not by driving directions. Details are in the delivery timeline.')
  function fitRoute() {
    if (!ready || destroyed || routeKey === fittedRouteKey) return
    const coordinates = stopsFor(shipment).flatMap(stop => stop.coordinates ? [stop.coordinates] : [])
    const location = freshLocation(shipment, now())
    if (!coordinates.length && location) coordinates.push(location.coordinates)
    if (!coordinates.length) return
    const bounds = coordinates.reduce(([west, south, east, north], [longitude, latitude]) => [Math.min(west, longitude), Math.min(south, latitude), Math.max(east, longitude), Math.max(north, latitude)], [180, 90, -180, -90])
    map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 55, maxZoom: 14, duration: 0 })
    fittedRouteKey = routeKey
  }
  function update() {
    if (!ready || destroyed) return
    const features = shipmentFeatures(shipment, now()), nextKey = JSON.stringify(features), source = map.getSource(SOURCE)
    if (source) { if (nextKey !== featureKey) source.setData(features) }
    else map.addSource(SOURCE, { type: 'geojson', data: features })
    featureKey = nextKey
    const foreground = currentDark ? '#f4f4f4' : '#24272b', background = currentDark ? '#24272b' : '#ffffff'
    const stopColor = ['case', ['==', ['get', 'status'], 'completed'], '#53b98b', ['==', ['get', 'current'], true], '#397ee8', currentDark ? '#5b6068' : '#d1d5db']
    const layers = [
      { id: 'shipment-legs', type: 'line', source: SOURCE, filter: ['==', ['get', 'kind'], 'leg'], paint: { 'line-color': foreground, 'line-width': 2, 'line-opacity': 0.55, 'line-dasharray': [2, 2] } },
      { id: 'shipment-stops', type: 'circle', source: SOURCE, filter: ['==', ['get', 'kind'], 'stop'], paint: { 'circle-color': stopColor, 'circle-radius': 15, 'circle-stroke-width': 2, 'circle-stroke-color': background } },
      { id: 'shipment-stop-numbers', type: 'symbol', source: SOURCE, filter: ['==', ['get', 'kind'], 'stop'], layout: { 'text-field': ['to-string', ['get', 'number']], 'text-font': ['Noto%20Sans%20Regular'], 'text-size': 12, 'text-allow-overlap': true }, paint: { 'text-color': ['case', ['==', ['get', 'current'], true], '#ffffff', currentDark ? '#ffffff' : '#182026'] } },
      { id: 'shipment-courier', type: 'circle', source: SOURCE, filter: ['==', ['get', 'kind'], 'courier'], paint: { 'circle-color': '#397ee8', 'circle-radius': 8, 'circle-stroke-width': 3, 'circle-stroke-color': background } },
      { id: 'shipment-courier-label', type: 'symbol', source: SOURCE, filter: ['==', ['get', 'kind'], 'courier'], layout: { 'text-field': 'Courier', 'text-font': ['Noto%20Sans%20Regular'], 'text-size': 12, 'text-offset': [0, 1.5], 'text-allow-overlap': true }, paint: { 'text-color': foreground, 'text-halo-color': background, 'text-halo-width': 2 } },
    ]
    for (const layer of layers) {
      if (!map.getLayer(layer.id)) map.addLayer(layer)
      else for (const [key, value] of Object.entries(layer.paint)) map.setPaintProperty(layer.id, key, value)
    }
    fitRoute()
  }
  function expireLocation() {
    clearTimer(timer); timer = undefined
    const location = freshLocation(shipment, now())
    if (!location) return
    timer = setTimer(() => { timer = undefined; update(); expireLocation() }, Math.max(1, Math.ceil((location.at + COURIER_LOCATION_MAX_AGE_SECONDS - now()) * 1000)))
  }
  const loaded = () => { ready = true; update() }
  map.on('style.load', loaded); map.on('load', loaded)
  return {
    setShipment(value) {
      if (destroyed) return
      // Copy only display fields so later mutations cannot change the map silently.
      shipment = { stops: stopsFor(value), location: value?.location && { coordinates: validCoordinates(value.location.coordinates) ? [...value.location.coordinates] : null, at: value.location.at } }
      routeKey = JSON.stringify(shipment.stops.map(stop => [stop.id, stop.coordinates]))
      update(); expireLocation()
    },
    beginStyleChange(value) { ready = false; currentDark = !!value },
    destroy() {
      destroyed = true; clearTimer(timer); map.off('style.load', loaded); map.off('load', loaded)
      if (canvas) { if (previousLabel == null) canvas.removeAttribute('aria-label'); else canvas.setAttribute('aria-label', previousLabel) }
      shipment = null
    },
  }
}

/** Only public basemap blocks are fetched. Shipment fields never leave this adapter. */
export async function setupShipmentMap(container: HTMLElement, { dark = false, onError = () => {} }: ShipmentMapOptions = {}) {
  let overlay
  const map = await createMarketMap(container, { dark, onError, createOverlay: (instance, appearance) => {
    overlay = createShipmentOverlay(instance, { dark: appearance })
    return overlay
  } })
  return { setShipment: value => overlay.setShipment(value), setDark: value => map.setDark(value), resize: () => map.resize(), destroy: () => map.destroy() }
}
