import {mountNativeArea} from './native-area.ts';
import { createMarketMap, type MapListing } from './map/index.ts';
import { setupShipmentMap, type Shipment } from './map/shipment.ts';
import { validateServiceArea, type ServiceAreas } from './service-area.ts';

interface NativeMapBridge { ready(): void; select?(id: string): void }
export interface NativeMapController {
  setListings?(value: unknown): void;
  setShipment?(value: unknown): boolean;
  setDark(value: boolean): void;
}
interface NativeRenderer {
  setListings?(value: MapListing[]): void;
  setShipment?(value: Shipment): void;
  setDark(value: boolean): Promise<unknown> | void;
  destroy(): Promise<unknown> | void;
}
declare global {
  interface Window {
    webkit?: { messageHandlers?: { marketMap?: { postMessage(message: { type: string; id?: string }): void } } }
    MarketMapBridge?: NativeMapBridge;
    marketMap: NativeMapController;
  }
}
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const coordinates = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
const boundedText = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
function invalidShipment(): never { throw new Error('Delivery map data is invalid.'); }

/** Native sends a display projection only. Reject identities, tokens and unrelated order fields. */
export function cleanShipmentProjection(input: unknown, now = Date.now() / 1000): Shipment {
  if (!plainObject(input) || !onlyKeys(input, ['stops', 'location']) || !Array.isArray(input.stops) || input.stops.length > 12) invalidShipment();
  const ids = new Set<string>();
  const stops = input.stops.map(value => {
    if (!plainObject(value) || !onlyKeys(value, ['id', 'label', 'address', 'coordinates', 'status']) || !boundedText(value.id, 80) || !value.id || ids.has(value.id)) invalidShipment();
    if (value.label !== undefined && !boundedText(value.label, 120) || value.address !== undefined && !boundedText(value.address, 500)) invalidShipment();
    if (value.status !== undefined && (typeof value.status !== 'string' || !['pending', 'arrived', 'completed'].includes(value.status))) invalidShipment();
    if (value.coordinates !== undefined && !coordinates(value.coordinates)) invalidShipment();
    ids.add(value.id);
    return { id: value.id, label: (value.label ?? '') as string, address: (value.address ?? '') as string, status: (value.status ?? 'pending') as string,
      ...(value.coordinates !== undefined ? { coordinates: [...value.coordinates as [number, number]] } : {}) };
  });
  const result: Shipment = { stops };
  if (input.location !== undefined && input.location !== null) {
    const point = input.location;
    if (!plainObject(point) || !onlyKeys(point, ['coordinates', 'at']) || !coordinates(point.coordinates) || typeof point.at !== 'number' || !Number.isSafeInteger(point.at) || point.at < 0) invalidShipment();
    // Samples expire even without another native update; the overlay owns that timer.
    if (Number.isFinite(now) && point.at <= now && now - point.at < 120) result.location = { coordinates: [...point.coordinates], at: point.at };
  }
  return result;
}
export function cleanNativeListings(value: unknown): MapListing[] {
  if (!Array.isArray(value)) return [];
  let areaBytes = 0;
  const result: MapListing[] = [];
  for (const item of value.slice(0, 1000)) {
    if (!plainObject(item) || typeof item.id !== 'string' || !item.id || item.id.length > 225 || typeof item.title !== 'string') continue;
    const point = coordinates(item.coordinates) ? [...item.coordinates] : undefined;
    let serviceAreas: ServiceAreas | undefined;
    try {
      if (plainObject(item.serviceAreas) && onlyKeys(item.serviceAreas, ['pickup', 'destination'])) {
        const areas = { pickup: validateServiceArea(item.serviceAreas.pickup), destination: validateServiceArea(item.serviceAreas.destination) };
        const size = JSON.stringify(areas).length;
        // Bound the whole bridge projection as well as each shape. Geometry contains only ASCII numbers/type names.
        if (areaBytes + size <= 1048576) { serviceAreas = areas; areaBytes += size; }
      }
    } catch { /* A malformed area never becomes a guessed point. Valid independent point locations may remain. */ }
    if (!point && !serviceAreas) continue;
    result.push({ id: item.id, title: item.title.slice(0, 160), ...(point ? { coordinates: point } : {}), ...(serviceAreas ? { serviceAreas } : {}) });
  }
  return result;
}

/** A mode has one input surface. Private shipments cannot enter public listing layers. */
export function createNativeMapController({ shipmentMode = false, dark = false, onError = (_error: Error) => {}, onAppearance = (_dark: boolean) => {}, now = () => Date.now() / 1000 } = {}) {
  let renderer: NativeRenderer | null = null, closed = false, currentDark = dark;
  let listings: MapListing[] = [], shipment: Shipment = { stops: [] };
  function setDark(value: boolean) {
    if (closed) return;
    currentDark = !!value; onAppearance(currentDark);
    if (renderer) Promise.resolve(renderer.setDark(currentDark)).catch(onError);
  }
  const api: NativeMapController = Object.freeze(shipmentMode ? {
    setShipment(value: unknown) {
      if (closed) return false;
      try { shipment = cleanShipmentProjection(value, now()); renderer?.setShipment?.(shipment); return true; }
      catch { shipment = { stops: [] }; renderer?.setShipment?.(shipment); onError(new Error('Delivery map data is invalid.')); return false; }
    }, setDark,
  } : {
    setListings(value: unknown) { if (closed) return; listings = cleanNativeListings(value); renderer?.setListings?.(listings); }, setDark,
  });
  return {
    api,
    async attach(value: NativeRenderer) {
      if (closed) { await value.destroy(); return; }
      renderer = value;
      if (shipmentMode) renderer.setShipment?.(shipment); else renderer.setListings?.(listings);
      await renderer.setDark(currentDark);
    },
    async close() {
      if (closed) return;
      closed = true; listings = []; shipment = { stops: [] };
      if (shipmentMode) renderer?.setShipment?.(shipment);
      await renderer?.destroy(); renderer = null;
    },
  };
}

export async function mountNativeMap() {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const params = new URLSearchParams(location.search), shipmentMode = params.get('mode') === 'shipment';
  if(params.get('mode')==='area'){document.documentElement.dataset.appearance=params.get('theme')==='dark'?'dark':'light';return mountNativeArea();}
  const dark = params.get('theme') === 'dark';
  let disposed = false, instance: Awaited<ReturnType<typeof createMarketMap>> | null = null;
  const showError = (_error: unknown) => { if (!disposed) $('map-status').textContent = 'Map unavailable'; };
  const send = (type: 'ready' | 'select', id?: string) => {
    if (disposed || shipmentMode && type === 'select') return;
    if (window.webkit?.messageHandlers?.marketMap) window.webkit.messageHandlers.marketMap.postMessage({ type, ...(id ? {id} : {}) });
    else if (type === 'ready') window.MarketMapBridge?.ready();
    else if (type === 'select') window.MarketMapBridge?.select?.(id);
  };
  const controller = createNativeMapController({ shipmentMode, dark, onError: showError, onAppearance: value => { document.documentElement.dataset.appearance = value ? 'dark' : 'light'; } });
  window.marketMap = controller.api;
  window.marketMap.setDark(dark);
  document.title = shipmentMode ? 'Delivery map' : 'Listing map';
  $('map-status').textContent = 'Loading map…';
  const storage = document.querySelector<HTMLElement>('.map-storage');
  if (storage) storage.hidden = shipmentMode;
  async function stats() {
    if (!instance || disposed) return;
    const data = await instance.getStorageStats();
    if (!disposed) $('map-usage').textContent = `${(data.bytes / 1048576).toFixed(1)} / ${Math.round(data.maxBytes / 1048576)} MB`;
  }
  $<HTMLSelectElement>('map-cache').value = ['64','128','256','512'].includes(params.get('cache')) ? params.get('cache') : '512';
  $<HTMLSelectElement>('map-cache').onchange = async () => { try { await instance?.setCacheMiB(Number($<HTMLSelectElement>('map-cache').value)); await stats(); } catch(error) { showError(error); } };
  $('map-clear').onclick = async () => { try { await instance?.clearCache(); await stats(); } catch(error) { showError(error); } };
  const interval = shipmentMode ? null : setInterval(() => stats().catch(() => {}), 5000);
  window.addEventListener('pagehide', () => { disposed = true; if (interval !== null) clearInterval(interval); void controller.close(); }, { once: true });
  send('ready');
  try {
    if (shipmentMode) {
      const map = await setupShipmentMap($('map-canvas'), { dark, onError: showError });
      await controller.attach(map);
    } else {
      instance = await createMarketMap($('map-canvas'), { dark, cacheMiB: Number($<HTMLSelectElement>('map-cache').value), onSelect: listing => send('select', listing.id), onError: showError });
      await controller.attach(instance); await stats();
    }
    if (!disposed) { $('map-status').textContent = shipmentMode ? 'Stops joined directly; not driving directions.' : 'Approximate locations shared by authors'; send('ready'); }
  } catch(error) { showError(error); }
  return controller;
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') void mountNativeMap();
