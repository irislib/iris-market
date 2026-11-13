<script lang="ts">
  import {onDestroy} from 'svelte'
  import {applyEvent, isNewer, LISTING_KIND, type MarketListing} from '../market.ts'
  import {cachedCollections, loadCollections, type ProductCollection} from '../collections.ts'
  import Editor from './Editor.svelte'
  import type {PanelOptions} from './types.ts'

  let {options}: {options: PanelOptions} = $props()
  const author = options.author
  const controller = new AbortController()
  const records = new Map<string, MarketListing>()
  let memberRequest: AbortController | undefined
  let inventoryLoaded = false

  // Listings, accounts and collections live outside Svelte; bump this to re-read them.
  let version = $state(0)
  let activeId = $state('')
  let incomplete = $state(false)
  let loaded = $state(false)
  let note = $state('')
  let editing = $state<{previous?: ProductCollection} | null>(null)

  const active = (listing: MarketListing) => listing.status === 'active' && (listing.expiration === null || listing.expiration > Date.now() / 1000)
  const available = (row: MarketListing) => active(row) && !options.isHidden(row.id)
  const canEdit = () => !options.preview && options.account().owner === author
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

  function mergeVisible() {
    for (const row of options.listings()) {
      if (row.rawEvent?.kind === LISTING_KIND && isNewer(row, records.get(row.id))) records.set(row.id, row)
    }
  }
  const touch = () => { if (!controller.signal.aborted) version++ }

  const view = $derived.by(() => {
    void version
    mergeVisible()
    return {editable: canEdit(), collections: cachedCollections(author, options.account().pending)}
  })

  function shelf(collection: ProductCollection) {
    void version
    const cards: MarketListing[] = []
    let missing = 0
    for (const address of collection.members) {
      const listing = records.get(address.slice('30402:'.length))
      if (listing && available(listing)) cards.push(listing)
      else if (!listing || !options.isHidden(listing.id)) missing++
    }
    return {cards, missing}
  }

  function cards(node: HTMLElement, rows: MarketListing[]) {
    const draw = (list: MarketListing[]) => node.replaceChildren(...list.map(options.makeCard))
    draw(rows)
    return {update: draw}
  }

  function toggle(collection: ProductCollection) {
    const open = activeId === collection.identifier
    activeId = open ? '' : collection.identifier
    memberRequest?.abort()
    if (!open) void hydrate(collection)
  }

  async function hydrate(collection: ProductCollection) {
    memberRequest?.abort()
    const request = new AbortController()
    memberRequest = request
    const ids = new Set(collection.members.map(address => address.slice('30402:'.length)))
    const filters = [...ids].map(id => ({kinds: [LISTING_KIND], authors: [id.slice(0, 64)], '#d': [id.slice(65)], limit: 4}))
    if (!filters.length) return
    try {
      const {events} = await options.query(filters, {signal: request.signal, limit: Math.min(256, filters.length * 4), deadline: Date.now() + 7000, cache: 'network-only'})
      if (request.signal.aborted) return
      for (const event of events) {
        try {
          const id = event.pubkey + ':' + event.tags.find(tag => tag[0] === 'd')?.[1]
          if (event.kind === LISTING_KIND && ids.has(id) && applyEvent(records, event, {maxRecords: 5000})) options.cacheListing(event)
        } catch { /* Invalid products never become collection cards. */ }
      }
      touch()
    } catch { if (!request.signal.aborted) touch() }
  }

  // Read the existing public listing cache locally, even when Browse has active filters.
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

  async function loadOwnListings() {
    if (inventoryLoaded || !canEdit()) return
    try {
      const {events, complete} = await options.query([{kinds: [LISTING_KIND], authors: [author], limit: 128}],
        {signal: controller.signal, limit: 256, deadline: Date.now() + 7000, cache: 'network-only'})
      if (controller.signal.aborted) return
      for (const event of events) {
        if (event.kind === LISTING_KIND && event.pubkey === author) try { applyEvent(records, event, {maxRecords: 5000}) } catch {}
      }
      inventoryLoaded = complete
      touch()
    } catch { /* Locally available products remain editable. */ }
  }

  async function load() {
    if (!options.preview) {
      try {
        const result = await loadCollections(author, {query: options.query, signal: controller.signal, pending: options.account().pending})
        if (controller.signal.aborted) return
        incomplete = result.incomplete
      } catch { incomplete = true }
    }
    loaded = true
    touch()
  }

  /** Signing is only reachable from the explicit publish control. */
  function edit(previous?: ProductCollection) {
    if (!canEdit()) return
    if (!options.account().canSign) { options.connectSigner(); return }
    editing = {previous}
    void loadOwnListings()
  }

  function published(identifier: string, delivery: 'queued' | 'published') {
    activeId = identifier
    editing = null
    note = delivery === 'queued' ? 'Collection queued for publication.' : 'Collection published.'
    touch()
  }

  export function refresh() {
    if (!canEdit()) editing = null
    touch()
  }

  const unsubscribe = options.onAccountChange(refresh)
  void load()
  void restoreLocal()
  // Recheck expiry while the profile remains open.
  const timer = setInterval(refresh, 30000)
  onDestroy(() => { controller.abort(); memberRequest?.abort(); unsubscribe(); clearInterval(timer) })
</script>

<div class="collection-header">
  <h2>Public collections</h2>
  {#if view.editable && !editing}
    <button type="button" class="button primary" onclick={() => edit()}>New collection</button>
  {/if}
</div>
<div>
  {#if editing && view.editable}
    {#key editing}
      <Editor {options} {records} {available} {version} previous={editing.previous}
        current={() => cachedCollections(author, options.account().pending)}
        refresh={() => { mergeVisible(); touch() }}
        onCancel={() => editing = null} onPublished={published} />
    {/key}
  {/if}
</div>
<div class="collection-shelves">
  {#each view.collections as collection (collection.identifier)}
    {@const open = collection.identifier === activeId}
    {@const count = collection.members.length}
    <section class="collection-shelf">
      <button type="button" class="collection-toggle" aria-expanded={open} onclick={() => toggle(collection)}>
        <strong>{collection.title}</strong>
        <span class="muted small">{plural(count, 'listing', 'listings')}{collection.delivery === 'queued' ? ' · Queued' : ''}</span>
      </button>
      {#if open}
        {@const {cards: rows, missing} = shelf(collection)}
        {#if view.editable && !editing}
          <button type="button" class="text-button collection-edit" onclick={() => edit(collection)}>Edit collection</button>
        {/if}
        <div class="listing-grid" use:cards={rows}></div>
        {#if missing}
          <p class="muted small">{missing} {missing === 1 ? 'listing is' : 'listings are'} unavailable.</p>
          <button type="button" class="text-button" onclick={() => void hydrate(collection)}>Check again</button>
        {/if}
      {/if}
    </section>
  {:else}
    <p class="muted">{loaded ? 'No public collections yet.' : 'Looking for collections…'}</p>
  {/each}
  {#if incomplete}
    <button type="button" class="text-button" onclick={() => void load()}>Retry collection lookup</button>
  {/if}
</div>
<p class="muted small" role="status">{note}</p>
