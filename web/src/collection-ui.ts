import type { Event, EventTemplate, Filter } from 'nostr-tools'
import type { RuntimeQueryOptions } from 'nostr-pubsub'
import { element as el } from './dom.ts'
import { applyEvent, isNewer, LISTING_KIND, type MarketListing } from './market.ts'
import {
  buildCollectionDraft, cachedCollections, COLLECTION_LIMITS, loadCollections, rememberCollection,
  type ProductCollection,
} from './collections.ts'

interface PanelOptions {
  author: string
  host: HTMLElement
  preview: boolean
  account: () => { owner?: string; canSign: boolean; pending?: Event[] }
  onAccountChange: (listener: () => void) => () => void
  connectSigner: () => void
  listings: () => Iterable<MarketListing>
  loadLocalListings: () => Promise<Event[]>
  cacheListing: (event: Event) => void
  sellerName: (author: string) => string
  isSaved: (id: string) => boolean
  isHidden: (id: string) => boolean
  makeCard: (listing: MarketListing) => HTMLElement
  query: (filters: Filter[], options: RuntimeQueryOptions) => ReturnType<import('./nostr-runtime.ts').PublicEventRuntime['query']>
  publish: (draft: EventTemplate, previousId: string | null) => Promise<{event: Event; delivery: 'queued' | 'published'}>
}

const addressOf = (listing: MarketListing) => `30402:${listing.id}`
const active = (listing: MarketListing) => listing.status === 'active' && (listing.expiration === null || listing.expiration > Date.now() / 1000)
function button(label: string, action: () => void, style = 'button secondary') {
  const value = el('button', label, style)
  value.type = 'button'
  value.onclick = action
  return value
}

/** One open profile owns its requests. Signing is only reachable from the explicit publish control. */
export function setupCollectionPanel(options: PanelOptions) {
  const { author, host, query } = options
  const controller = new AbortController()
  let memberRequest: AbortController | undefined
  let activeId = '', incomplete = false, loaded = false
  const records = new Map<string, MarketListing>()
  const current = () => cachedCollections(author, options.account().pending)
  const canEdit = () => !options.preview && options.account().owner === author
  const available = (row: MarketListing) => active(row) && !options.isHidden(row.id)
  const header = el('div', undefined, 'collection-header')
  const editor = el('div')
  const shelves = el('div', undefined, 'collection-shelves')
  const note = el('p', '', 'muted small')
  note.setAttribute('role', 'status')
  host.replaceChildren(header, editor, shelves, note)

  function mergeVisible() {
    for (const row of options.listings()) {
      if (row.rawEvent?.kind === LISTING_KIND && isNewer(row, records.get(row.id))) records.set(row.id, row)
    }
  }
  function render() {
    if (controller.signal.aborted) return
    mergeVisible()
    header.replaceChildren(el('h2', 'Public collections'))
    if (canEdit() && !editor.childElementCount) header.append(button('New collection', () => edit(), 'button primary'))
    const collections = current()
    shelves.replaceChildren()
    for (const collection of collections) {
      const group = el('section', undefined, 'collection-shelf')
      const open = collection.identifier === activeId
      const count = collection.members.length
      const toggle = button('', () => {
        activeId = open ? '' : collection.identifier
        memberRequest?.abort()
        render()
        if (!open) void hydrate(collection)
      }, 'collection-toggle')
      toggle.setAttribute('aria-expanded', String(open))
      toggle.append(el('strong', collection.title), el('span', `${count} ${count === 1 ? 'listing' : 'listings'}${collection.delivery === 'queued' ? ' · Queued' : ''}`, 'muted small'))
      group.append(toggle)
      if (open) {
        if (canEdit() && !editor.childElementCount) group.append(button('Edit collection', () => edit(collection), 'text-button collection-edit'))
        const grid = el('div', undefined, 'listing-grid')
        let missing = 0
        for (const address of collection.members) {
          const listing = records.get(address.slice('30402:'.length))
          if (listing && available(listing)) grid.append(options.makeCard(listing))
          else if (!listing || !options.isHidden(listing.id)) missing++
        }
        group.append(grid)
        if (missing) {
          group.append(el('p', `${missing} ${missing === 1 ? 'listing is' : 'listings are'} unavailable.`, 'muted small'),
            button('Check again', () => void hydrate(collection), 'text-button'))
        }
      }
      shelves.append(group)
    }
    if (!collections.length) shelves.append(el('p', loaded ? 'No public collections yet.' : 'Looking for collections…', 'muted'))
    if (incomplete) shelves.append(button('Retry collection lookup', () => void load(), 'text-button'))
  }
  async function hydrate(collection: ProductCollection) {
    memberRequest?.abort()
    const request = new AbortController()
    memberRequest = request
    const ids = new Set(collection.members.map(address => address.slice('30402:'.length)))
    const filters = [...ids].map(id => ({kinds: [LISTING_KIND], authors: [id.slice(0, 64)], '#d': [id.slice(65)], limit: 4}))
    if (!filters.length) return
    try {
      const { events } = await query(filters, {signal: request.signal, limit: Math.min(256, filters.length * 4), deadline: Date.now() + 7000, cache: 'network-only'})
      if (request.signal.aborted) return
      for (const event of events) {
        try {
          const id = event.pubkey + ':' + event.tags.find(tag => tag[0] === 'd')?.[1]
          if (event.kind === LISTING_KIND && ids.has(id) && applyEvent(records, event, {maxRecords: 5000})) options.cacheListing(event)
        } catch { /* Invalid products never become collection cards. */ }
      }
      render()
    } catch { if (!request.signal.aborted) render() }
  }
  // Read the existing public listing cache locally, even when Browse has active filters.
  // Private saved IDs are only used for filtering the picker on this device.
  async function restoreLocal() {
    if (options.preview) return
    try {
      const events = await options.loadLocalListings()
      for (const [index, event] of events.entries()) {
        if (controller.signal.aborted) return
        if (event.kind === LISTING_KIND) try { applyEvent(records, event, {maxRecords: 5000}) } catch {}
        if (index % 32 === 31) await new Promise(resolve => setTimeout(resolve, 0))
      }
      refresh()
    } catch { /* The in-memory listings remain available. */ }
  }
  let inventoryLoaded = false
  async function loadOwnListings(update: () => void) {
    if (inventoryLoaded || !canEdit()) return
    try {
      const { events, complete } = await query([{kinds: [LISTING_KIND], authors: [author], limit: 128}],
        {signal: controller.signal, limit: 256, deadline: Date.now() + 7000, cache: 'network-only'})
      if (controller.signal.aborted) return
      for (const event of events) {
        if (event.kind === LISTING_KIND && event.pubkey === author) try { applyEvent(records, event, {maxRecords: 5000}) } catch {}
      }
      inventoryLoaded = complete
      update()
    } catch { /* Locally available products remain editable. */ }
  }
  async function load() {
    if (!options.preview) {
      try {
        const result = await loadCollections(author, {query, signal: controller.signal, pending: options.account().pending})
        if (controller.signal.aborted) return
        incomplete = result.incomplete
      } catch { incomplete = true }
    }
    loaded = true
    render()
  }

  let refreshPicker: (() => void) | undefined
  function edit(previous?: ProductCollection) {
    if (!canEdit()) return
    if (!options.account().canSign) { options.connectSigner(); return }
    const selected = new Set(previous?.members ?? [])
    const form = el('form', undefined, 'collection-form')
    const nameLabel = el('label', 'Collection name')
    const title = el('input')
    title.placeholder = 'My favorite products'
    title.value = previous?.title ?? ''
    title.maxLength = COLLECTION_LIMITS.title * 2
    title.required = true
    nameLabel.append(title)
    const sources = el('div', undefined, 'collection-sources')
    const pool = [...records.values()]
    let source = pool.some(row => options.isSaved(row.id) && available(row)) ? 'Saved' : 'My listings'
    const search = el('input')
    search.type = 'search'
    search.placeholder = 'Find a listing'
    search.setAttribute('aria-label', 'Filter listings')
    const choices = el('div', undefined, 'collection-choices')
    const count = el('p', '', 'small muted')
    const error = el('p', '', 'error small')
    error.setAttribute('role', 'alert')
    const submit = el('button', previous ? 'Publish changes' : 'Publish collection', 'button primary')
    submit.type = 'submit'
    let submitting = false
    let lastChoices = ''
    const cancel = button('Cancel', () => { refreshPicker = undefined; editor.replaceChildren(); render() }, 'text-button')
    const updateCount = () => {
      count.textContent = `${selected.size} of ${COLLECTION_LIMITS.members} listings selected`
      const tooLong = [...title.value.trim()].length > COLLECTION_LIMITS.title
      title.setCustomValidity(tooLong ? `Use up to ${COLLECTION_LIMITS.title} characters.` : '')
      submit.disabled = submitting || !selected.size || !title.value.trim() || tooLong
    }
    function drawChoices() {
      if (controller.signal.aborted || editor.firstChild !== form) return
      mergeVisible()
      for (const tab of sources.children) tab.setAttribute('aria-pressed', String(tab.textContent === source))
      const term = search.value.trim().toLocaleLowerCase()
      const rows = new Map<string, string>()
      if (source === 'Selected') for (const address of selected) {
        const row = records.get(address.slice('30402:'.length))
        rows.set(address, row && available(row) ? row.title : 'Unavailable listing')
      }
      else for (const row of records.values()) {
        if (!available(row) || source === 'Saved' && !options.isSaved(row.id) || source === 'My listings' && row.author !== author) continue
        rows.set(addressOf(row), row.title)
      }
      const matches = [...rows].filter(([,label]) => !term || label.toLocaleLowerCase().includes(term))
      const key = JSON.stringify([source, matches, [...selected], term])
      updateCount()
      if (key === lastChoices) return
      lastChoices = key
      choices.replaceChildren()
      for (const [address, label] of matches) {
        const choice = el('label')
        const check = el('input')
        check.type = 'checkbox'
        check.checked = selected.has(address)
        check.setAttribute('aria-label', label)
        check.onchange = () => {
          error.textContent = ''
          if (check.checked && selected.size >= COLLECTION_LIMITS.members) {
            check.checked = false
            error.textContent = `Choose up to ${COLLECTION_LIMITS.members} listings.`
          } else if (check.checked) selected.add(address)
          else selected.delete(address)
          lastChoices = ''
          if (source === 'Selected') drawChoices()
          updateCount()
        }
        const caption = el('span', label)
        const listing = records.get(address.slice(6))
        if (listing) caption.append(el('small', options.sellerName(listing.author), 'muted'))
        choice.append(check, caption)
        choices.append(choice)
      }
      if (!choices.childElementCount) choices.append(el('p', term ? 'No matching listings.' : source === 'Saved' ? 'Save a listing to find it here.' : source === 'Selected' ? 'Choose listings from the other tabs.' : 'No listings to choose from yet.', 'muted small'))
      updateCount()
    }
    for (const label of ['Saved', 'My listings', 'Browse', 'Selected']) {
      sources.append(button(label, () => { source = label; drawChoices() }, 'collection-source'))
    }
    title.oninput = updateCount
    search.oninput = drawChoices
    const actions = el('div', undefined, 'profile-actions')
    actions.append(submit, cancel)
    form.append(el('h3', previous ? 'Edit collection' : 'New collection'), nameLabel, el('p', 'Selected listings will be public on your profile.', 'muted small'),
      sources, search, choices, count, error, actions)
    form.onsubmit = async event => {
      event.preventDefault()
      if (submitting || !canEdit() || !options.account().canSign) return
      try {
        if (previous && current().find(item => item.identifier === previous.identifier)?.event.id !== previous.event.id) throw Error('This collection has changed. Reopen it to edit the latest version.')
        mergeVisible()
        for (const address of selected) {
          if (previous?.members.includes(address)) continue
          const row = records.get(address.slice(6))
          if (!row || !available(row)) throw Error('A selected listing is unavailable. Remove it to publish.')
        }
        const draft = buildCollectionDraft({author, title: title.value, members: [...selected], previous})
        submitting = true
        cancel.disabled = true
        form.inert = true
        updateCount()
        const result = await options.publish(draft, previous?.event.id ?? null)
        rememberCollection(result.event, result.delivery)
        if (controller.signal.aborted) return
        activeId = result.event.tags.find(tag => tag[0] === 'd')[1]
        refreshPicker = undefined
        editor.replaceChildren()
        note.textContent = result.delivery === 'queued' ? 'Collection queued for publication.' : 'Collection published.'
        render()
      } catch (cause) { error.textContent = cause instanceof Error ? cause.message : 'Could not publish this collection.' }
      finally { submitting = false; form.inert = false; cancel.disabled = false; updateCount() }
    }
    refreshPicker = drawChoices
    editor.replaceChildren(form)
    render()
    drawChoices()
    title.focus()
    void loadOwnListings(drawChoices)
  }
  const refresh = () => {
    if (!canEdit() && editor.childElementCount) { editor.replaceChildren(); refreshPicker = undefined }
    render()
    refreshPicker?.()
  }
  const unsubscribe = options.onAccountChange(refresh)
  render()
  void load()
  void restoreLocal()
  // Recheck expiry while the profile remains open.
  const timer = setInterval(refresh, 30000)
  return { refresh, close() { controller.abort(); memberRequest?.abort(); unsubscribe(); clearInterval(timer) } }
}
