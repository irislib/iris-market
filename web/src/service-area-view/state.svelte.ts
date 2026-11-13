import {setLoadingStatus} from '../loading-status.ts'
import {createPlaceSearch} from '../places/search.ts'
import {serviceAreaCircle, validateServiceArea, MIN_SERVICE_AREA_RADIUS_KM, MAX_SERVICE_AREA_RADIUS_KM} from '../service-area.ts'
import type {ServiceAreaPoint, ServiceAreas} from '../service-area.ts'
import type {createMarketMap} from '../map/index.ts'
import {createServiceAreaOverlay, restoreServiceAreaCircle} from '../service-area-ui.ts'

export type Role = 'pickup' | 'destination'
type Areas = Partial<ServiceAreas>
type MapFactory = typeof createMarketMap
type MapInstance = Awaited<ReturnType<MapFactory>>
export interface PickerOptions {
  value?: ServiceAreas | null
  onChange?: (value: ServiceAreas | null) => void
  readOnly?: boolean
  createMap?: MapFactory
  geolocation?: Pick<Geolocation, 'getCurrentPosition'>
  searchPlaces?: (query: string) => Promise<{name: string; displayName?: string; context?: string; contextParts?: string[]; lat: number; lng: number}[]>
}
export const labels: Record<Role, string> = {pickup: 'Pickup', destination: 'Destination'}
const keyFor = (value: unknown) => JSON.stringify(value)

/** Starts unselected. Only an explicit map/location action creates a public boundary. */
export class ServiceAreaPickerState {
  areas = $state.raw<Areas>({})
  samePickup = $state(true)
  active = $state<Role>('pickup')
  centers = $state.raw<Partial<Record<Role, ServiceAreaPoint>>>({})
  radii = $state.raw<Record<Role, number>>({pickup: 10, destination: 10})
  map = $state.raw<MapInstance | null>(null)
  error = $state('')
  searchStatus = $state('')
  suggestions = $state.raw<{label: string; choose: () => void}[]>([])
  retryHidden = $state(true)
  locateBusy = $state(false)

  readonly readOnly: boolean
  readonly root: HTMLElement
  search: HTMLInputElement | undefined
  radius: HTMLInputElement | undefined
  canvas: HTMLElement | undefined
  message: HTMLElement | undefined
  overlay: ReturnType<typeof createServiceAreaOverlay> | null = null

  private readonly options: PickerOptions
  private readonly placeSource: ReturnType<typeof createPlaceSearch> | null
  private readonly themeEvents = globalThis.window
  private readonly systemDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
  private searchTicket = 0
  private searchTimer: ReturnType<typeof setTimeout> | undefined
  private destroyed = false
  private visible = false
  private mapFailed = false
  private ticket = 0
  private locationTicket = 0
  private mapDark: boolean | null = null
  private opening: Promise<void> | null = null

  constructor(root: HTMLElement, options: PickerOptions) {
    this.root = root
    this.options = options
    this.readOnly = options.readOnly ?? false
    this.placeSource = options.searchPlaces ? null : createPlaceSearch()
    this.themeEvents?.addEventListener('market-themechange', this.themeChanged)
    this.systemDark?.addEventListener('change', this.themeChanged)
    this.setValue(options.value ?? null)
  }

  projected(): Areas { return this.samePickup && this.areas.pickup ? {pickup: this.areas.pickup, destination: this.areas.pickup} : this.areas }
  getValue = (): ServiceAreas | null => { const value = this.projected(); return value.pickup && value.destination ? {pickup: value.pickup, destination: value.destination} : null }
  validate = (): ServiceAreas | null => {
    const value = this.projected()
    if (!value.pickup && !value.destination) return null
    if (!value.pickup) throw new Error('Choose a pickup area.')
    if (!value.destination) throw new Error('Choose a destination area.')
    return {pickup: value.pickup, destination: value.destination}
  }

  linked = $derived(this.active === 'destination' && this.samePickup)
  selected = $derived(this.projected()[this.active])
  selection = $derived.by(() => this.selected
    ? (this.linked ? 'Same as pickup' : this.centers[this.active] ? `${this.radii[this.active]} km around the selected point` : 'Custom boundary selected')
    : this.readOnly ? 'Area not set' : `Choose a ${this.active === 'pickup' ? 'pickup' : 'destination'} area on the map.`)

  private darkAppearance() {
    const appearance = globalThis.document?.documentElement?.dataset.appearance
    return appearance === 'dark' || appearance !== 'light' && !!this.systemDark?.matches
  }
  private status(message: string, pending = false) { if (this.message) setLoadingStatus(this.message, message, pending) }
  private failMap() { this.mapFailed = true; this.status('Map unavailable.'); this.retryHidden = false }

  themeChanged = () => {
    const current = this.map, dark = this.darkAppearance()
    if (this.destroyed || !this.visible || !current || dark === this.mapDark) return
    this.mapDark = dark
    void current.setDark(dark).catch(() => { if (!this.destroyed && this.map === current) { this.mapDark = null; this.failMap() } })
  }

  /** Pushes the radius control and map overlay; everything else renders from state. */
  paint() {
    if (this.radius) this.radius.value = String(this.radii[this.active])
    this.overlay?.setCenters(this.samePickup && this.centers.pickup ? {pickup: this.centers.pickup, destination: this.centers.pickup} : this.centers)
    this.overlay?.setAreas(this.projected())
  }
  private changed() { this.paint(); this.options.onChange?.(this.getValue()) }
  private stopLocating() { this.locationTicket++; this.locateBusy = false }

  cancelSearch() { this.searchTicket++; clearTimeout(this.searchTimer); this.suggestions = []; this.searchStatus = '' }

  choose(point: ServiceAreaPoint) {
    if (this.destroyed || this.readOnly || this.linked) return
    this.stopLocating()
    try {
      const geometry = serviceAreaCircle(point, this.radii[this.active])
      this.areas = {...this.areas, [this.active]: geometry}
      this.centers = {...this.centers, [this.active]: [...point]}
      this.error = ''
      this.changed()
    } catch (cause) { this.error = cause.message || 'Choose a different area.' }
  }

  onSearch() {
    const search = this.search
    this.cancelSearch()
    if (search.value.trim().length < 2) return
    this.searchStatus = 'Searching places…'
    const version = this.searchTicket, role = this.active
    this.searchTimer = setTimeout(async () => {
      try {
        const values = await (this.options.searchPlaces ?? this.placeSource.search)(search.value)
        if (this.destroyed || !this.visible || version !== this.searchTicket || role !== this.active) return
        this.searchStatus = values.length ? '' : 'No matching places. Choose a point on the map.'
        this.suggestions = values.slice(0, 8).map(place => ({
          label: [place.name, place.context || place.contextParts?.join(', ')].filter(Boolean).join(' · '),
          choose: () => {
            if (version !== this.searchTicket || role !== this.active) return
            this.choose([place.lng, place.lat]); search.value = place.name; this.cancelSearch(); this.overlay?.focus(role)
          },
        }))
      } catch {
        if (version === this.searchTicket) { this.searchStatus = ''; this.error = 'Place search unavailable. Choose a point on the map.' }
      }
    }, 250)
  }

  selectRole(role: Role) {
    this.stopLocating(); this.active = role; this.cancelSearch()
    if (this.search) this.search.value = ''
    this.error = ''; this.paint(); this.overlay?.focus(role)
  }

  setSame(checked: boolean) { this.stopLocating(); this.samePickup = checked; this.error = ''; this.changed() }

  onRadius() {
    const next = Number(this.radius.value), active = this.active
    if (!Number.isFinite(next) || next < MIN_SERVICE_AREA_RADIUS_KM || next > MAX_SERVICE_AREA_RADIUS_KM) { this.error = 'Choose a radius from 0.1 to 2000 km.'; return }
    const previous = this.radii[active]
    this.radii = {...this.radii, [active]: next}
    const center = this.centers[active]
    if (center) {
      try { this.areas = {...this.areas, [active]: serviceAreaCircle(center, next)}; this.error = ''; this.changed() }
      catch (cause) { this.radii = {...this.radii, [active]: previous}; this.error = cause.message || 'Choose a smaller area.' }
    } else { this.error = ''; this.paint() }
  }

  clear() {
    if (this.destroyed || this.readOnly) return
    this.stopLocating()
    if (this.samePickup) { this.areas = {}; this.centers = {} }
    else {
      const areas = {...this.areas}, centers = {...this.centers}
      delete areas[this.active]; delete centers[this.active]
      this.areas = areas; this.centers = centers
    }
    this.error = ''; this.changed()
  }

  locate() {
    if (this.destroyed || this.readOnly || this.linked) return
    const api = this.options.geolocation ?? globalThis.navigator?.geolocation
    if (!api) { this.error = 'Location is unavailable. Choose an area on the map.'; return }
    const current = ++this.locationTicket, role = this.active, version = this.ticket
    this.locateBusy = true
    api.getCurrentPosition(position => {
      if (this.destroyed || !this.visible || current !== this.locationTicket || version !== this.ticket) return
      this.locateBusy = false
      if (role !== this.active) return
      this.choose([position.coords.longitude, position.coords.latitude])
    }, () => {
      if (this.destroyed || current !== this.locationTicket || version !== this.ticket) return
      this.locateBusy = false
      this.error = 'Could not get your location. Choose an area on the map.'
    }, {enableHighAccuracy: false, timeout: 10000, maximumAge: 60000})
  }

  async startMap(): Promise<void> {
    if (this.destroyed || !this.visible || this.map) return
    if (this.opening) { await this.opening; if (!this.destroyed && this.visible && !this.map && !this.mapFailed) return this.startMap(); return }
    const current = this.ticket
    this.mapFailed = false; this.status('Loading map…', true); this.retryHidden = true
    const live = () => !this.destroyed && this.visible && current === this.ticket
    const operation = (async () => {
      try {
        const factory = this.options.createMap ?? (await import('../map/index.ts')).createMarketMap
        if (!live()) return
        const dark = this.darkAppearance()
        const instance = await factory(this.canvas, {dark, onError: () => { if (live()) this.failMap() }, createOverlay: instance => {
          const next = createServiceAreaOverlay(instance, {areas: this.projected(), interactive: !this.readOnly, onPick: point => { if (live()) this.choose(point) }})
          if (current === this.ticket) this.overlay = next
          return next
        }})
        if (!live()) { await instance.destroy(); return }
        this.map = instance; this.mapDark = dark
        if (!this.mapFailed) this.status('')
        this.paint(); instance.resize(); this.themeChanged()
      } catch { if (live()) this.failMap() }
    })()
    this.opening = operation
    await operation
    if (this.opening === operation) this.opening = null
  }

  setValue(value: ServiceAreas | null) {
    const next: Areas = value ? {pickup: validateServiceArea(value.pickup), destination: validateServiceArea(value.destination)} : {}
    this.areas = next
    this.samePickup = !value || keyFor(next.pickup) === keyFor(next.destination)
    if (this.samePickup) this.areas = {pickup: next.pickup}
    const centers: Partial<Record<Role, ServiceAreaPoint>> = {}, radii = {...this.radii}
    for (const role of ['pickup', 'destination'] as const) {
      const area = next[role], circle = area && restoreServiceAreaCircle(area)
      if (circle) { centers[role] = circle.point; radii[role] = circle.radius }
    }
    this.centers = centers; this.radii = radii
    this.active = 'pickup'; this.error = ''; this.stopLocating(); this.paint()
  }

  async closeMap() {
    const previous = this.map
    this.map = null; this.mapDark = null; this.overlay = null
    if (previous) try { await previous.destroy() } catch { /* Closing the view must not leave an unhandled cache-close rejection. */ }
  }

  async retry() { this.ticket++; this.mapFailed = false; await this.closeMap(); await this.startMap() }

  async show() {
    if (this.destroyed) return
    const wasVisible = this.visible
    this.visible = true; this.root.hidden = false
    if (wasVisible && this.mapFailed) return
    await this.startMap()
    if (this.visible && !this.destroyed) this.map?.resize()
  }

  hide() { this.cancelSearch(); this.visible = false; this.root.hidden = true; this.ticket++; this.stopLocating(); void this.closeMap() }

  /** Returns false when already destroyed. */
  async destroy() {
    if (this.destroyed) return false
    this.cancelSearch(); void this.placeSource?.close()
    this.destroyed = true; this.visible = false; this.ticket++; this.stopLocating()
    this.themeEvents?.removeEventListener('market-themechange', this.themeChanged)
    this.systemDark?.removeEventListener('change', this.themeChanged)
    await this.closeMap(); await this.opening
    return true
  }
}
