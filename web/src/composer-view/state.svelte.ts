import {flushSync} from 'svelte'
import {encodeLocationHash,locationHash} from '../map/geohash.ts'
import {exactListingPoint} from '../map/listing-pin.ts'
import {currentPosition} from '../location-filter.ts'
import {composerTradeTools} from '../marketplace-tools.ts'
import {byId, formFields} from '../dom.ts'
import {parseEvent} from '../market.ts'
import {createDraftFiles, type DraftFile, type PriceNode} from '../composer-preview.ts'
import {relativeExpiry} from '../expiry.ts'
import {courierListingType,isTransportTag} from '../transport-type.ts'
import {validateDelivery} from '../delivery.ts'
import {parseServiceAreas} from '../service-area.ts'
import {setupServiceAreaPicker} from '../service-area-ui.ts'
import type {Surface} from '../surface.ts'
import {
  closedBitcoinDraft,composerControlState,createAttachmentSelection,deliveryPreviewLabel,listingDraft,revisedListingDraft,signedListingPublication,
} from '../composer.ts'

export interface ComposerOptions {
  account: any; isPreview: () => boolean; onPublished: (event: any, receipt?: any, showSaved?: boolean) => void
  defaultCurrency?: () => string; loadUploader?: () => Promise<any>; page?: HTMLElement
  onNavigate?: () => void; onClose?: () => void; priceNode?: PriceNode
}
type AreaPicker = ReturnType<typeof setupServiceAreaPicker>
export interface ComposerPreview {draft: any; files: DraftFile[]; delivery: string | null; area?: AreaPicker; areaInMedia: boolean}

const DELIVERY_HINT = 'Choose destinations and a fixed delivery cost.'

/**
 * Form values stay in their native controls (form reset, FormData and the trade
 * tools read and write them directly); this state holds what the view renders.
 */
export class ComposerState {
  heading = $state('Post a listing')
  reviewing = $state(false)
  busy = $state(false)
  error = $state('')
  progress = $state('')
  publishLabel = $state('Publish listing')
  side = $state('offer')
  pinHint = $state('Only the selected area will be public.')
  category = $state('other')
  areaHidden = $state(false)
  shippingEnabled = $state(false)
  countries = $state<string[]>([])
  canRemoveDelivery = $state(false)
  deliveryHint = $state(DELIVERY_HINT)
  keepLabel = $state('Keep current')
  editing = $state.raw<any>(null)
  files = $state.raw<{file: File; uploaded: boolean}[]>([])
  preview = $state.raw<ComposerPreview | undefined>()
  controls = $derived(composerControlState({busy: this.busy, editing: !!this.editing, shippingEnabled: this.shippingEnabled, category: this.category}))

  readonly options: ComposerOptions
  readonly dialog: Surface
  readonly areaPicker: AreaPicker
  readonly selection: ReturnType<typeof createAttachmentSelection>
  form!: HTMLFormElement
  headingNode!: HTMLHeadingElement
  mapPin!: HTMLDetailsElement
  areaEditor!: HTMLDetailsElement
  tradeTools!: ReturnType<typeof composerTradeTools>

  private draftId = crypto.randomUUID()
  private pendingEvent: any
  private pendingShipping: any
  private shippingTouched = false
  pendingOpen = false
  private currencyTouched = false
  private uploader: any
  private uploadController: AbortController | null | undefined
  private filePosition = {index: 0, total: 0}
  private reviewedValues: Record<string, any> | undefined
  private reviewOwner: string | undefined
  private localFiles: ReturnType<typeof createDraftFiles> | undefined
  private areaTouched = false
  private areaPreview: AreaPicker | undefined
  private removeExistingDelivery = false
  private initialTransportType = ''
  private preservedTransportTags: string[] = []
  private pinTouched = false
  private pinRequest = 0

  constructor(options: ComposerOptions, dialog: Surface) {
    this.options = options
    this.dialog = dialog
    this.areaPicker = setupServiceAreaPicker({onChange: () => { this.areaTouched = true; this.clearPending() }})
    const {account, loadUploader = () => import('../uploads.ts')} = options
    this.selection = createAttachmentSelection(async (file, uploadOptions) => {
      if (!this.uploader) {
        const module = await loadUploader()
        this.uploader = module.createMediaUploader({signEvent: draft => account.messaging.signEvent(draft), getCacheMiB: () => Number(byId('map-cache')?.value) || 128, onProgress: step => {
          const phase = {preparing: 'Preparing', uploading: 'Uploading', verifying: 'Checking', complete: 'Checking'}[step.phase] || 'Uploading'
          this.progress = `${phase} file ${this.filePosition.index + 1} of ${this.filePosition.total}…`
        }})
      }
      return this.uploader.upload(file, uploadOptions)
    })
  }

  get fields() { return formFields(this.form) }
  private get precision() { return this.form.querySelector<HTMLSelectElement>('[name=pinPrecision]') }
  private clearPending() { this.pendingEvent = null; this.pendingShipping = null }

  /** Runs once the form is in the document: the trade tools insert their own controls into it. */
  attach() {
    this.tradeTools = composerTradeTools(this.form)
    this.dialog.addEventListener('close', () => { this.pinRequest++; this.uploadController?.abort(); this.releasePreview(); this.areaPicker.hide() })
  }

  // Pin
  paintPin() {
    this.pinHint = this.precision.value === 'exact' ? 'Publishing shares these coordinates with everyone.' : 'Only the selected area will be public.'
  }
  changePin() { this.pinTouched = true; this.pinRequest++; this.paintPin(); this.clearPending() }
  changePrecision() {
    const legacyHash = locationHash(this.fields.location.value), pinField = this.fields.pinCoordinates
    if (!this.pinTouched && !pinField.value.trim() && legacyHash) pinField.value = '#' + legacyHash
    this.changePin()
  }
  async useLocation() {
    const request = ++this.pinRequest, id = this.draftId, selected = this.precision.value
    try {
      const {coords} = await currentPosition(navigator.geolocation, selected === 'exact')
      if (request !== this.pinRequest || id !== this.draftId || !this.dialog.open || this.reviewing || this.busy) return
      const pinField = this.fields.pinCoordinates
      pinField.value = selected === 'exact' ? coords.latitude.toFixed(7) + ', ' + coords.longitude.toFixed(7)
        : '#' + encodeLocationHash(coords.longitude, coords.latitude, Number(selected))
      pinField.dispatchEvent(new Event('input', {bubbles: true}))
      this.error = ''
    } catch { if (request === this.pinRequest && id === this.draftId) this.error = 'Location unavailable. Enter coordinates or a geohash instead.' }
  }

  // Delivery
  private changedDelivery() { this.shippingTouched = true; this.clearPending() }
  paintDelivery() { this.shippingEnabled = this.fields.shippingEnabled.checked }
  toggleDelivery() { this.changedDelivery(); this.paintDelivery() }
  addCountry(select: HTMLSelectElement) {
    if (!select.value) return
    if (!this.countries.includes(select.value)) this.countries = [...this.countries, select.value]
    select.value = ''; this.changedDelivery(); this.paintDelivery()
  }
  removeCountry(code: string) { this.countries = this.countries.filter(value => value !== code); this.changedDelivery(); this.paintDelivery() }
  removeDelivery() {
    this.removeExistingDelivery = true; this.fields.shippingEnabled.checked = false; this.changedDelivery(); this.paintDelivery()
    this.canRemoveDelivery = false; this.deliveryHint = 'Existing delivery will be removed when you publish.'
  }

  // Category, transport and areas
  syncAreaEditor() {
    this.category = this.fields.category.value
    this.areaHidden = this.category !== 'transport' && !this.areaTouched && !this.editing?.serviceAreas
    flushSync()
    if (this.dialog.open && !this.reviewing && !this.areaHidden && this.areaEditor.open) void this.areaPicker.show(); else this.areaPicker.hide()
  }

  // Side
  chooseSide(side: string) { if (this.busy) return; this.side = side; this.clearPending() }

  // Files
  paintFiles() { this.files = this.selection.items() }
  addFiles(input: HTMLInputElement) {
    try { this.selection.add(input.files); this.clearPending(); this.error = ''; this.paintFiles() } catch (cause) { this.error = cause.message } finally { input.value = '' }
  }
  removeFile(index: number) { this.selection.remove(index); this.clearPending(); this.paintFiles() }

  syncKeepOption() { this.keepLabel = this.editing ? `Keep current (${relativeExpiry(this.editing.expiration)?.replace(/^Expires /, '') || 'never'})` : 'Keep current' }

  /** Native controls the view does not own (trade tools, area picker) follow the busy state directly. */
  setBusy(value: boolean) {
    this.busy = value
    const trade = this.form.querySelector('.post-trade-tools'), picker = this.areaPicker.element
    for (const field of this.form.elements) if (trade?.contains(field) || picker.contains(field)) (field as HTMLInputElement).disabled = value
    this.paintFiles()
    if (!value) { this.paintDelivery(); this.syncAreaEditor(); this.syncKeepOption(); this.tradeTools.sync(!!this.editing) }
    this.publishLabel = value ? 'Saving…' : (this.editing ? 'Save changes' : 'Publish listing')
  }

  // Editor and preview
  releasePreview() { this.localFiles?.close(); this.localFiles = undefined; void this.areaPreview?.destroy(); this.areaPreview = undefined; this.preview = undefined }
  showEditor() {
    this.tradeTools.sync(!!this.editing); this.syncKeepOption(); this.releasePreview(); this.reviewedValues = undefined; this.reviewOwner = undefined
    this.reviewing = false; this.dialog.classList.remove('showing-preview'); this.heading = this.editing ? 'Edit listing' : 'Post a listing'
    this.error = ''; this.progress = ''; this.syncAreaEditor()
  }
  drawPreview() {
    this.releasePreview()
    const values = this.reviewedValues
    const draft = this.pendingEvent || (this.editing ? revisedListingDraft(values, this.editing) : listingDraft(values, {identifier: this.draftId}))
    const localFiles = this.localFiles = createDraftFiles(this.selection.items().map(item => item.file))
    const delivery = deliveryPreviewLabel(values.shipping, String(values.currency || 'EUR'))
    this.areaPicker.hide()
    const areas = parseServiceAreas(draft.tags)
    if (areas) this.areaPreview = setupServiceAreaPicker({value: areas, readOnly: true})
    const areaInMedia = !draft.tags.some(tag => tag[0] === 'image') && !localFiles.items.some(file => file.image)
    this.preview = {draft, files: localFiles.items, delivery, area: this.areaPreview, areaInMedia}
    this.reviewing = true; this.dialog.classList.add('showing-preview'); this.heading = 'Preview'; this.publishLabel = this.editing ? 'Save changes' : 'Publish listing'
    flushSync()
    if (this.areaPreview) void this.areaPreview.show()
  }
  editDraft() { this.showEditor(); flushSync(); this.fields.title.focus() }

  input(event: Event) {
    const name = (event.target as HTMLInputElement).name ?? ''
    if (name.startsWith('shipping')) this.shippingTouched = true
    this.clearPending()
    if (name === 'currency') this.currencyTouched = true
  }

  review() {
    if (this.busy) return
    const {account} = this.options, fields = this.fields
    const values: Record<string, any> = Object.fromEntries(new FormData(this.form)); this.error = ''; this.progress = ''
    if (!this.pinTouched && (this.editing || !fields.pinCoordinates.value.trim())) { delete values.pinCoordinates; delete values.pinPrecision }
    try {
      Object.assign(values, this.tradeTools.choices())
      if (this.editing && (values.transportType === undefined || values.transportType === this.initialTransportType)) {
        if (values.transportType === this.initialTransportType) delete values.transportType
        values.tags = [...String(values.tags || '').split(','), ...this.preservedTransportTags]
      } else if (this.editing && values.transportType === '') values.transportType = 'none'
      if (!this.editing || fields.shippingEnabled.checked || this.removeExistingDelivery) values.shipping = validateDelivery(fields.shippingEnabled.checked ? {countries: [...this.countries], price: fields.shippingPrice.value.trim()} : null)
      if (this.areaTouched) values.serviceAreas = this.areaPicker.validate()
      this.reviewedValues = values; this.reviewOwner = account.state().ownerPubkey
      this.drawPreview()
      const heading = this.headingNode; heading.tabIndex = -1; heading.focus(); heading.scrollIntoView({block: 'start'})
    } catch (cause) { this.releasePreview(); this.reviewedValues = undefined; this.error = cause.message }
  }

  /** The only path to signing and publication: the explicit Publish control on a reviewed draft. */
  async publish() {
    if (this.busy || !this.reviewedValues) return
    const {account, isPreview, onPublished} = this.options
    if (!account.state().canSign) { this.pendingOpen = true; account.showAccount({posting: true}); return }
    this.error = ''; this.progress = ''
    const owner = account.state().ownerPubkey
    try {
      if (isPreview()) throw new Error('Switch to the live market to post.')
      if (this.reviewOwner && this.reviewOwner !== owner) throw new Error('Your profile changed. Edit and preview the listing again.')
      if (this.editing && this.editing.author !== owner) throw new Error('Sign in with the profile that owns this listing.')
    } catch (cause) { this.error = cause.message; return }
    const values = {...this.reviewedValues}
    if (this.pendingEvent && this.pendingEvent.pubkey !== owner || this.pendingShipping && this.pendingShipping.pubkey !== owner) this.clearPending()
    this.uploadController = new AbortController(); const active = this.uploadController; this.setBusy(true)
    try {
      const files = await this.selection.uploadAll({signal: active.signal, onFile: (index, total) => { this.filePosition = {index, total} }})
      if (active.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError')
      if (account.state().ownerPubkey !== owner) throw new Error('Your profile changed. Edit and preview the listing again.')
      if (!this.pendingEvent && account.state().mode !== 'local') this.publishLabel = 'Waiting for signature…'
      const publication = await signedListingPublication(values, {
        previous: this.editing, identifier: this.draftId, attachments: files, pendingEvent: this.pendingEvent, pendingShipping: this.pendingShipping,
        onShipping: event => { this.pendingShipping = event }, signEvent: draft => account.messaging.signEvent(draft),
      })
      const signed = publication.event
      parseEvent(signed)
      this.pendingEvent = signed; this.pendingShipping = publication.shipping
      if (active.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError')
      this.publishLabel = 'Saving…'; this.progress = ''
      const receipts = await account.messaging.publishSignedEvents([...(this.pendingShipping ? [this.pendingShipping] : []), signed])
      const showSaved = this.dialog.open
      this.clearPending(); this.editing = null; this.draftId = crypto.randomUUID()
      this.form.reset(); this.pinTouched = false; this.pinRequest++; this.paintPin(); this.mapPin.open = false
      this.shippingTouched = false; this.countries = []; this.removeExistingDelivery = false; this.canRemoveDelivery = false; this.paintDelivery()
      this.selection.clear(); this.currencyTouched = false; this.areaPicker.setValue(null); this.areaTouched = false; this.areaEditor.open = false
      this.showEditor(); this.dialog.hide()
      onPublished(signed, receipts.at(-1), showSaved)
    } catch (cause) { this.error = cause.name === 'AbortError' ? 'Upload stopped. Your draft and selected files are still here.' : cause.message || 'Could not publish. Your draft is still here.' }
    finally { this.uploadController = null; this.setBusy(false); this.progress = '' }
  }

  open() {
    const {account, defaultCurrency = () => 'EUR'} = this.options
    this.tradeTools.sync(!!this.editing); this.pendingOpen = false; account.closeAccount()
    const currency = this.fields.currency
    if (!this.reviewedValues && !this.currencyTouched && currency.value !== defaultCurrency()) { currency.value = defaultCurrency(); this.clearPending() }
    this.error = ''
    if (this.reviewedValues) this.drawPreview()
    this.dialog.showModal(); this.syncAreaEditor()
  }

  edit(listing) {
    const {account} = this.options
    if (listing.author !== account.state().ownerPubkey) return
    this.editing = listing; this.tradeTools.setEditingOffer(listing.escrow); this.draftId = listing.identifier; this.clearPending()
    this.selection.clear(); this.paintFiles()
    const fields = this.fields, precision = this.precision
    this.side = listing.side ?? ''
    for (const key of ['title', 'description', 'price', 'currency', 'location']) fields[key].value = listing[key] ?? ''
    const exact = exactListingPoint(listing.originalTags || [], listing.geohash)
    this.pinRequest++; this.pinTouched = false
    for (const option of [...precision.options]) if (option.dataset.previous) option.remove()
    const originalPrecision = String(listing.geohash?.length || 4)
    if (!exact && ![...precision.options].some(option => option.value === originalPrecision)) { const option = new Option(originalPrecision + ' characters', originalPrecision); option.dataset.previous = 'true'; precision.add(option) }
    precision.value = exact ? 'exact' : originalPrecision
    fields.pinCoordinates.value = exact ? exact[1] + ', ' + exact[0] : listing.geohash ? '#' + listing.geohash : ''
    this.paintPin(); this.mapPin.open = !!listing.geohash
    fields.category.value = String(listing.category).toLowerCase(); if (!fields.category.value) fields.category.value = 'other'
    fields.image.value = listing.imageUrl || ''
    this.initialTransportType = listing.category === 'transport' ? courierListingType(listing) || '' : ''
    this.preservedTransportTags = (listing.tags || []).filter(isTransportTag)
    fields.transportType.value = this.initialTransportType
    fields.tags.value = (listing.tags || []).filter(tag => tag !== listing.category && (listing.category !== 'transport' || !isTransportTag(tag))).join(', ')
    fields.expiration.value = 'keep'; fields.shippingEnabled.checked = false; fields.shippingPrice.value = ''
    this.countries = []; this.shippingTouched = false; this.removeExistingDelivery = false
    const hasDelivery = !!listing.originalTags?.some(tag => tag[0] === 'shipping_option')
    this.canRemoveDelivery = hasDelivery; this.paintDelivery()
    this.deliveryHint = hasDelivery ? 'Existing delivery options are kept unless you change these fields.' : DELIVERY_HINT
    this.areaPicker.setValue(listing.serviceAreas ?? null); this.areaTouched = false; this.areaEditor.open = !!listing.serviceAreas
    this.currencyTouched = true; this.showEditor(); this.open()
  }

  private hasAreaDraft() { try { return !!this.areaPicker.validate() } catch { return true } }

  prefill(values) {
    const fields = this.fields
    if (this.busy || this.editing || this.reviewedValues || fields.pinCoordinates.value.trim() || this.shippingTouched || this.countries.length || fields.shippingEnabled.checked || fields.shippingPrice.value.trim() || fields.transportType.value || this.selection.items().length || this.hasAreaDraft() || ['title', 'description', 'price', 'location', 'image', 'tags', 'expiration'].some(key => fields[key].value.trim())) {
      this.open(); this.error = 'Your current draft is still here. Finish it before starting another listing.'; return false
    }
    // A service announcement is an ordinary editable listing; publishing still
    // requires the normal explicit preview and Publish action.
    this.side = String(values.side ?? '')
    for (const key of ['category', 'title', 'description', 'price', 'location']) fields[key].value = String(values[key] ?? '')
    const incomingTags = Array.isArray(values.tags) ? values.tags : String(values.tags || '').split(',')
    fields.transportType.value = values.category === 'transport' ? courierListingType({tags: incomingTags}) || '' : ''
    fields.tags.value = incomingTags.filter(tag => values.category !== 'transport' || !isTransportTag(tag)).join(', ')
    this.areaPicker.setValue(values.serviceAreas ?? null); this.areaTouched = Object.hasOwn(values, 'serviceAreas'); this.areaEditor.open = !!values.serviceAreas
    this.showEditor(); this.open(); return true
  }

  async closeBitcoin(listing) {
    const {account, isPreview, onPublished} = this.options
    if (isPreview() || !account.state().canSign || listing.author !== account.state().ownerPubkey) throw Error('Sign in with the profile that posted this offer.')
    const event = await account.messaging.signEvent(closedBitcoinDraft(listing))
    const receipt = await account.messaging.publishSignedEvent(event)
    onPublished(event, receipt)
  }

  hide({preservePending = false} = {}) { if (!preservePending) this.pendingOpen = false; this.dialog.hide() }

  destroy() { this.uploadController?.abort(); this.releasePreview(); void this.areaPicker.destroy(); void this.uploader?.close() }
}
