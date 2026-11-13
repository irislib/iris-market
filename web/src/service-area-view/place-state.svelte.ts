import {createPlaceSearch} from '../places/search.ts'
import {createServiceAreaOverlay} from '../service-area-ui.ts'
import type {DeliveryPlace, Coordinates} from '../orders.ts'
import type {createMarketMap} from '../map/index.ts'

export interface DeliveryPlaceInputOptions {
  label: string; value?: DeliveryPlace; onChange?: (value: DeliveryPlace) => void; onDraftChange?: (value: DeliveryPlace) => void
  createMap?: typeof createMarketMap
  geolocation?: Pick<Geolocation, 'getCurrentPosition'>
  searchPlaces?: (query: string) => Promise<{name: string; displayName?: string; context?: string; lat: number; lng: number}[]>
}

/** Private, transient meeting point editor. Nothing is saved or sent by this control. */
export class DeliveryPlaceState {
  point = $state.raw<Coordinates | undefined>()
  status = $state('')
  suggestions = $state.raw<{label: string; choose: () => void}[]>([])
  locateBusy = $state(false)
  mapReady = $state(false)

  readonly label: string
  readonly root: HTMLElement
  // Keeps the last mounted field: read() still works after destroy, as callers may read a closed form.
  private field: HTMLInputElement | undefined
  get input() { return this.field }
  set input(node: HTMLInputElement | undefined) { if (node) this.field = node }
  details: HTMLDetailsElement | undefined
  canvas: HTMLElement | undefined
  overlay: ReturnType<typeof createServiceAreaOverlay> | null = null

  private readonly options: DeliveryPlaceInputOptions
  private readonly source: ReturnType<typeof createPlaceSearch> | null
  private readonly systemDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
  private placeLabel: string
  private destroyed = false
  private searchTicket = 0
  private locationTicket = 0
  private mapTicket = 0
  private opening = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private map: Awaited<ReturnType<typeof createMarketMap>> | null = null
  private rawMap: any = null

  constructor(root: HTMLElement, options: DeliveryPlaceInputOptions) {
    this.root = root
    this.options = options
    this.label = options.label
    this.point = options.value?.coordinates ? [...options.value.coordinates] as Coordinates : undefined
    this.placeLabel = options.value?.label ?? options.label
    this.source = options.searchPlaces ? null : createPlaceSearch()
    globalThis.window?.addEventListener('market-themechange', this.themeChanged)
    this.systemDark?.addEventListener('change', this.themeChanged)
  }

  private draft(address: string): DeliveryPlace {
    return {label: this.placeLabel.slice(0, 120), address, ...(this.point ? {coordinates: [...this.point] as Coordinates} : {})}
  }
  read = (): DeliveryPlace => {
    const address = this.input.value.trim()
    if (!address || address.length > 500) { this.input.focus?.(); throw new Error(`Enter the ${this.label.toLowerCase()} address or meeting point.`) }
    return this.draft(address)
  }
  private stopLocating() { this.locationTicket++; this.locateBusy = false }
  private changed() {
    this.overlay?.setCenters(this.point ? {pickup: this.point} : {})
    this.options.onDraftChange?.(this.draft(this.input.value.trim()))
    if (this.input.value.trim()) this.options.onChange?.(this.read())
  }
  cancelSearch() { this.searchTicket++; clearTimeout(this.timer); this.suggestions = [] }

  choose = (next: Coordinates) => {
    if (this.destroyed || next.length !== 2 || !next.every(Number.isFinite) || Math.abs(next[0]) > 180 || Math.abs(next[1]) > 90) return
    this.point = [...next] as Coordinates
    this.stopLocating()
    this.status = 'Map point selected. Add an address or meeting point.'
    this.changed()
  }

  searchAddress = () => {
    if (this.destroyed) return
    this.cancelSearch(); this.stopLocating(); this.point = undefined; this.placeLabel = this.label; this.status = ''; this.changed()
    const input = this.input
    if (input.value.trim().length < 2) return
    this.status = 'Searching places…'
    const ticket = this.searchTicket
    this.timer = setTimeout(async () => {
      try {
        const results = await (this.options.searchPlaces ?? this.source.search)(input.value)
        if (this.destroyed || ticket !== this.searchTicket) return
        this.status = results.length ? '' : 'No matching places. Enter an address or choose a map point.'
        this.suggestions = results.slice(0, 8).map(place => ({
          label: [place.name, place.context || (place.displayName !== place.name ? place.displayName : undefined)].filter(Boolean).join(' · '),
          choose: () => {
            if (this.destroyed || ticket !== this.searchTicket) return
            input.value = [place.name, place.context].filter(Boolean).join(', ').slice(0, 500)
            this.placeLabel = place.name.slice(0, 120)
            this.cancelSearch(); this.choose([place.lng, place.lat])
            this.status = 'Place selected. Add any entrance or meeting details.'
            this.rawMap?.jumpTo({center: [place.lng, place.lat], zoom: 15})
          },
        }))
      } catch { if (!this.destroyed && ticket === this.searchTicket) this.status = 'Place search unavailable. You can enter the address yourself.' }
    }, 250)
  }

  locate() {
    if (this.destroyed) return
    const api = this.options.geolocation ?? globalThis.navigator?.geolocation
    if (!api) { this.status = 'Location unavailable. Enter an address or choose a map point.'; return }
    const ticket = ++this.locationTicket
    this.locateBusy = true
    api.getCurrentPosition(position => {
      if (this.destroyed || ticket !== this.locationTicket) return
      this.choose([position.coords.longitude, position.coords.latitude])
      this.rawMap?.jumpTo({center: this.point, zoom: 15})
    }, () => {
      if (this.destroyed || ticket !== this.locationTicket) return
      this.locateBusy = false
      this.status = 'Could not get your location. Enter an address or choose a map point.'
    }, {enableHighAccuracy: false, timeout: 10000, maximumAge: 60000})
  }

  clear() { if (this.destroyed) return; this.stopLocating(); this.point = undefined; this.status = ''; this.changed() }

  private dark() {
    const appearance = document.documentElement.dataset.appearance
    return appearance === 'dark' || appearance !== 'light' && !!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches
  }
  themeChanged = () => {
    if (this.map) void this.map.setDark(this.dark()).catch(() => { if (!this.destroyed) this.status = 'Map unavailable. Your entered address is still available.' })
  }

  openMap = async () => {
    if (this.destroyed || !this.details.open) return
    if (this.map) { this.map.resize(); return }
    if (this.opening) return
    this.opening = true
    const ticket = ++this.mapTicket
    this.status = 'Loading map…'
    try {
      const factory = this.options.createMap ?? (await import('../map/index.ts')).createMarketMap
      if (this.destroyed || ticket !== this.mapTicket) return
      const instance = await factory(this.canvas, {dark: this.dark(), onError: () => { if (!this.destroyed) this.status = 'Map unavailable. You can enter the address yourself.' }, createOverlay: raw => {
        this.rawMap = raw
        const next = createServiceAreaOverlay(raw, {interactive: true, onPick: this.choose})
        this.overlay = next
        next.setCenters(this.point ? {pickup: this.point} : {})
        raw.getCanvas().setAttribute('aria-label', `${this.label} map. Click a point, or use arrow keys and press Enter.`)
        if (this.point) raw.jumpTo({center: this.point, zoom: 15})
        return next
      }})
      if (this.destroyed || ticket !== this.mapTicket) { await instance.destroy(); return }
      this.map = instance; this.mapReady = true; this.status = ''
      if (this.details.open) instance.resize()
      this.themeChanged()
    } catch { if (!this.destroyed) this.status = 'Map unavailable. Close and reopen Map to retry.' } finally { this.opening = false }
  }

  async showMap() { if (this.destroyed) return; this.details.open = true; await this.openMap() }

  setValue(next: DeliveryPlace) {
    if (this.destroyed) return
    this.cancelSearch(); this.locationTicket++
    this.input.value = next.address
    this.placeLabel = next.label || this.label
    this.point = next.coordinates ? [...next.coordinates] as Coordinates : undefined
    this.overlay?.setCenters(this.point ? {pickup: this.point} : {})
    if (this.point) this.rawMap?.jumpTo({center: this.point, zoom: 15})
  }

  /** Returns false when already destroyed. */
  destroy() {
    if (this.destroyed) return false
    this.destroyed = true; this.cancelSearch(); this.locationTicket++; this.mapTicket++
    globalThis.window?.removeEventListener('market-themechange', this.themeChanged)
    this.systemDark?.removeEventListener('change', this.themeChanged)
    void this.source?.close().catch(() => {})
    const previous = this.map
    this.map = null; this.rawMap = null; this.overlay = null
    if (previous) void previous.destroy().catch(() => {})
    return true
  }
}
