<script lang="ts">
  import {SvelteSet} from 'svelte/reactivity'
  import type {MarketListing} from '../market.ts'
  import {buildCollectionDraft, COLLECTION_LIMITS, rememberCollection, type ProductCollection} from '../collections.ts'
  import type {PanelOptions} from './types.ts'

  type Props = {
    options: PanelOptions
    records: Map<string, MarketListing>
    available: (row: MarketListing) => boolean
    version: number
    previous?: ProductCollection
    current: () => ProductCollection[]
    refresh: () => void
    onCancel: () => void
    onPublished: (identifier: string, delivery: 'queued' | 'published') => void
  }
  let {options, records, available, version, previous, current, refresh, onCancel, onPublished}: Props = $props()

  const author = options.author
  const addressOf = (listing: MarketListing) => `30402:${listing.id}`
  const sources = ['Saved', 'My listings', 'Browse', 'Selected']
  const selected = new SvelteSet<string>(previous?.members ?? [])
  let title = $state(previous?.title ?? '')
  let term = $state('')
  let error = $state('')
  let submitting = $state(false)
  let source = $state([...records.values()].some(row => options.isSaved(row.id) && available(row)) ? 'Saved' : 'My listings')
  let titleInput: HTMLInputElement

  const tooLong = $derived([...title.trim()].length > COLLECTION_LIMITS.title)
  $effect(() => titleInput.setCustomValidity(tooLong ? `Use up to ${COLLECTION_LIMITS.title} characters.` : ''))
  $effect(() => titleInput.focus())

  const choices = $derived.by(() => {
    void version
    const rows = new Map<string, string>()
    if (source === 'Selected') for (const address of selected) {
      const row = records.get(address.slice('30402:'.length))
      rows.set(address, row && available(row) ? row.title : 'Unavailable listing')
    }
    else for (const row of records.values()) {
      if (!available(row) || source === 'Saved' && !options.isSaved(row.id) || source === 'My listings' && row.author !== author) continue
      rows.set(addressOf(row), row.title)
    }
    const needle = term.trim().toLocaleLowerCase()
    return [...rows].filter(([, label]) => !needle || label.toLocaleLowerCase().includes(needle))
      .map(([address, label]) => ({address, label, seller: records.get(address.slice(6))?.author}))
  })

  const emptyText = $derived(term.trim() ? 'No matching listings.' : source === 'Saved' ? 'Save a listing to find it here.'
    : source === 'Selected' ? 'Choose listings from the other tabs.' : 'No listings to choose from yet.')

  function choose(address: string, input: HTMLInputElement) {
    error = ''
    if (input.checked && selected.size >= COLLECTION_LIMITS.members) {
      input.checked = false
      error = `Choose up to ${COLLECTION_LIMITS.members} listings.`
    } else if (input.checked) selected.add(address)
    else selected.delete(address)
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (submitting || !options.account().canSign || options.preview || options.account().owner !== author) return
    try {
      if (previous && current().find(item => item.identifier === previous.identifier)?.event.id !== previous.event.id) throw Error('This collection has changed. Reopen it to edit the latest version.')
      refresh()
      for (const address of selected) {
        if (previous?.members.includes(address)) continue
        const row = records.get(address.slice(6))
        if (!row || !available(row)) throw Error('A selected listing is unavailable. Remove it to publish.')
      }
      const draft = buildCollectionDraft({author, title, members: [...selected], previous})
      submitting = true
      const result = await options.publish(draft, previous?.event.id ?? null)
      rememberCollection(result.event, result.delivery)
      onPublished(result.event.tags.find(tag => tag[0] === 'd')[1], result.delivery)
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Could not publish this collection.' }
    finally { submitting = false }
  }
</script>

<form class="collection-form" inert={submitting} onsubmit={submit}>
  <h3>{previous ? 'Edit collection' : 'New collection'}</h3>
  <label>Collection name
    <input bind:this={titleInput} bind:value={title} placeholder="My favorite products" maxlength={COLLECTION_LIMITS.title * 2} required>
  </label>
  <p class="muted small">Selected listings will be public on your profile.</p>
  <div class="collection-sources">
    {#each sources as label}
      <button type="button" class="collection-source" aria-pressed={source === label} onclick={() => source = label}>{label}</button>
    {/each}
  </div>
  <input type="search" bind:value={term} placeholder="Find a listing" aria-label="Filter listings">
  <div class="collection-choices">
    {#each choices as choice (choice.address)}
      <label>
        <input type="checkbox" checked={selected.has(choice.address)} aria-label={choice.label}
          onchange={e => choose(choice.address, e.currentTarget)}>
        <span>{choice.label}{#if choice.seller}<small class="muted">{options.sellerName(choice.seller)}</small>{/if}</span>
      </label>
    {:else}
      <p class="muted small">{emptyText}</p>
    {/each}
  </div>
  <p class="small muted">{selected.size} of {COLLECTION_LIMITS.members} listings selected</p>
  <p class="error small" role="alert">{error}</p>
  <div class="profile-actions">
    <button type="submit" class="button primary" disabled={submitting || !selected.size || !title.trim() || tooLong}>{previous ? 'Publish changes' : 'Publish collection'}</button>
    <button type="button" class="text-button" disabled={submitting} onclick={onCancel}>Cancel</button>
  </div>
</form>
