import type {OrderView} from '../orders.ts'
import {setupServiceAreaPicker} from '../service-area-ui.ts'
import {courierJobs, courierListings, courierServiceDraft, type CourierFeedOptions, type CourierListing, type CourierType} from '../courier-ui.ts'

export type CourierSection = 'work' | 'jobs' | 'service'
export interface CourierWorkspaceOptions extends CourierFeedOptions {
  getOwner: () => string | undefined
  getOrders: () => readonly OrderView[]
  renderOrder: (order: OrderView) => HTMLElement
  onReviews: (pubkey: string) => void
  onSignIn: () => void
  isPreview?: () => boolean
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  createAreaPicker?: typeof setupServiceAreaPicker
}
/** One refresh's snapshot of the external listings, orders and account. */
export interface CourierView {
  section: CourierSection
  owner: string | undefined
  preview: boolean
  active: OrderView[]
  finished: OrderView[]
  rows: CourierListing[]
  filtered: boolean
  limit: number
}
const preferenceKey = 'market-courier-type-v1'
const terminal = (order: Pick<OrderView, 'status'>) => ['delivered', 'cancelled'].includes(order.status)
const validType = (value: unknown): value is CourierType => typeof value === 'string' && ['parcel', 'passenger', 'both'].includes(value)
const browserStorage = () => { try { return globalThis.localStorage } catch { return undefined } }

/** A view of existing public listings and private jobs; opening it never announces availability or starts GPS. */
export class CourierWorkspaceState {
  section = $state<CourierSection>('work')
  type = $state<CourierType>('parcel')
  notice = $state('')
  view = $state.raw<CourierView | undefined>()
  more = $state.raw({hidden: true, disabled: false, text: 'Load more'})

  area: HTMLInputElement | undefined
  readonly options: CourierWorkspaceOptions
  readonly picker: ReturnType<typeof setupServiceAreaPicker>
  readonly isPreview: () => boolean
  visible = true
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined
  private readonly pagination: NonNullable<CourierFeedOptions['pagination']>
  private filterArea = ''
  private limit = 24
  private loading = false
  private destroyed = false
  private generation = 0
  private previousOwner: string | undefined

  constructor(options: CourierWorkspaceOptions) {
    this.options = options
    this.isPreview = options.isPreview ?? (() => false)
    this.pagination = options.pagination ?? (() => ({}))
    this.storage = options.storage === undefined ? browserStorage() : options.storage
    this.previousOwner = options.getOwner()
    this.picker = (options.createAreaPicker ?? setupServiceAreaPicker)({onChange: () => { this.notice = '' }})
    try { const saved = this.storage?.getItem(preferenceKey); if (validType(saved)) this.type = saved } catch { /* Session preferences still work. */ }
  }

  chooseType(value: CourierType) {
    this.type = value; this.limit = 24
    try { this.storage?.setItem(preferenceKey, value) } catch { /* Session preferences still work. */ }
    this.refresh()
  }

  openSection(value: CourierSection) { this.section = value; this.notice = ''; this.refresh() }

  submit() {
    this.notice = ''
    if (this.section === 'work') { this.filterArea = this.area.value.trim(); this.limit = 24; this.refresh(); return }
    if (this.section === 'service' && !this.isPreview()) {
      try { this.options.onAnnounce(courierServiceDraft(this.type, this.area.value, this.picker.validate())) }
      catch (cause) { this.notice = cause.message || 'Could not open the listing editor.' }
    }
  }

  refresh() {
    if (this.destroyed) return
    const owner = this.options.getOwner(), section = this.section, preview = this.isPreview()
    if (owner !== this.previousOwner) {
      this.previousOwner = owner
      if (this.area) this.area.value = ''
      this.filterArea = ''; this.picker.setValue(null); this.limit = 24; this.notice = ''; this.generation++
    }
    if (section === 'service' && this.visible && !preview) void this.picker.show(); else this.picker.hide()
    const view: CourierView = {section, owner, preview, active: [], finished: [], rows: [], filtered: !!this.filterArea, limit: this.limit}
    this.more = {...this.more, hidden: true}
    this.view = view
    if (section === 'jobs') {
      if (!owner) return
      const jobs = courierJobs(this.options.getOrders(), owner)
      view.active = jobs.filter(order => !terminal(order)); view.finished = jobs.filter(terminal)
      return
    }
    if (preview) return
    view.rows = courierListings(this.options.getListings(), {type: this.type, area: section === 'work' ? this.filterArea : '', side: section === 'service' ? 'offer' : 'request', owner})
    if (section === 'service') return
    const remote = this.pagination(), disabled = this.loading || !!remote.loading
    this.more = {hidden: view.rows.length <= this.limit && !(this.options.loadMore && (remote.hasMore || remote.error)), disabled, text: disabled ? 'Loading…' : remote.error ? 'Retry' : 'Load more'}
    if (remote.error && !this.notice) this.notice = 'Could not load more requests.'
  }

  async loadMore() {
    if (this.loading) return
    this.notice = ''
    const ticket = ++this.generation
    const rows = courierListings(this.options.getListings(), {type: this.type, area: this.filterArea, owner: this.options.getOwner()})
    if (rows.length > this.limit) { this.limit += 24; this.refresh(); return }
    if (!this.options.loadMore) return
    this.limit += 24; this.loading = true; this.refresh()
    try { await this.options.loadMore() } catch { if (ticket === this.generation) this.notice = 'Could not load more requests. Try again.' }
    finally { this.loading = false; if (!this.destroyed) this.refresh() }
  }

  show() { this.visible = true; this.refresh() }
  hide() { this.visible = false; this.picker.hide() }
  destroy() { this.destroyed = true; this.generation++; void this.picker.destroy() }
}
