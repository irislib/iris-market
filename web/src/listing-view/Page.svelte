<script lang="ts">
  import {fiatMethodLabel} from '../escrow-offer.ts'
  import {renderDescription} from '../description.ts'
  import {translationFields} from '../translation.ts'
  import {listingURL, validListingId} from '../routes.ts'
  import {listingPublishedAt} from '../listing-dates.ts'
  import {relativeExpiry} from '../expiry.ts'
  import {courierListingType} from '../transport-type.ts'
  import {place} from '../svelte/place.ts'
  import {heroImage} from './hero.ts'
  import Share from './Share.svelte'
  import type {ListingPageOptions, ListingPresentation} from './types.ts'

  let {listing, options}: {listing: ListingPresentation; options: ListingPageOptions} = $props()
  const {saved = false, onSave = () => {}, onBuy = () => {}, priceNode, authorRow = () => null, isPreview = false, owner = undefined, onEdit = undefined, onCloseBitcoin = undefined, onToast = () => {}, draftPreview = false, localImage = undefined} = options

  const hero = heroImage(listing, {draftPreview, localImage})
  let showingOriginal = $state(false)
  function selectImage(original: boolean) {
    showingOriginal = original
    hero.select(original, () => { showingOriginal = false })
  }
  selectImage(false)

  const transport = listing.category === 'transport' ? courierListingType(listing) : null
  const category = transport ? ({parcel: 'Delivery', passenger: 'Passenger ride', both: 'Delivery and passenger rides'}[transport]) : listing.category
  const bitcoin = listing.escrow?.trade === 'bitcoin_fiat' ? listing.escrow : undefined
  const quoteOnly = !!(bitcoin || listing.externalOrder) && !hero.local && !listing.imageUrl
  const context = listing.externalOrder ? listing.externalOrder.platform : bitcoin ? (listing.side === 'request' ? 'Buying bitcoin' : 'Selling bitcoin') : draftPreview ? `${listing.side === 'request' ? 'Buying' : 'Selling'} · ${category}` : listing.side === 'request' ? `Buying${transport ? ` · ${category}` : ''}` : category
  const author = !draftPreview && !isPreview && listing.author && !listing.externalOrder ? authorRow(listing) : null

  const added = listingPublishedAt(listing)
  const hasAdded = !draftPreview && added !== undefined
  const expiry = relativeExpiry(listing.expiration)
  const addedAt = hasAdded ? new Date(added * 1000) : null

  // Translation replaces the visible title and description prose, never literal values.
  let title = $state(listing.title)
  const prose: Text[] = []
  const description = listing.externalOrder && !draftPreview ? null : renderDescription(listing.description, draftPreview ? {} : {prose})
  const translation = () => translationFields([listing.title, ...prose.map(text => text.textContent)], values => {
    title = values[0]
    prose.forEach((text, index) => { text.textContent = values[index + 1] })
    hero.setAlt(values[0])
  })

  const showBuy = !isPreview && !listing.externalOrder && listing.author !== owner
  const showEdit = !isPreview && !listing.externalOrder && listing.author === owner && !!onEdit
  const showClose = !isPreview && !!bitcoin && listing.author === owner && !!onCloseBitcoin
  let closing = $state(false)
  let problem = $state('')
  async function closeOffer() {
    closing = true
    try { await onCloseBitcoin(listing) } catch (error) { problem = error.message; closing = false }
  }

  const terms = listing.externalOrder ? [
    ['Payment method', listing.externalOrder.methods], ['Settlement', listing.externalOrder.layer],
    ['Bitcoin amount', listing.externalOrder.quantity === null ? '' : listing.externalOrder.quantity.toLocaleString() + ' sats'],
    ['Premium', listing.externalOrder.premium === null ? '' : listing.externalOrder.premium + '%'],
  ].filter(([, value]) => value) : []

  // Only the verified public wire event is exported, never the listing view
  // model, account state, private messages or computed relationship data.
  const raw = !isPreview && !draftPreview && listing.rawEvent ? (({id, pubkey, created_at, kind, tags, content, sig}) => JSON.stringify({id, pubkey, created_at, kind, tags, content, sig}, null, 2))(listing.rawEvent) : ''
  let copyStatus = $state('')
  async function copyEvent() {
    try { await navigator.clipboard.writeText(raw); copyStatus = 'Copied' } catch { copyStatus = 'Could not copy. Select the text below.' }
  }
  const dateLabel = (value: Date) => value.toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'})
</script>

<article class={['detail-layout', quoteOnly && 'detail-quote-only']}>
  <div class="detail-media" hidden={quoteOnly}>
    {#each hero.nodes as node}<span hidden use:place={() => node}></span>{/each}
    {#if hero.canToggle}
      <button type="button" class="image-original-toggle" aria-pressed={showingOriginal} aria-label={showingOriginal ? 'Pause image' : 'Show original image'} title={showingOriginal ? 'Pause image' : 'Show original'} onclick={() => selectImage(!showingOriginal)}></button>
    {/if}
  </div>
  <div class="detail-copy">
    <div class="eyebrow">{context}</div>
    <h1>{title}</h1>
    <span hidden use:place={() => priceNode(listing, 'detail-price')}></span>
    {#if !listing.externalOrder}<p class="detail-place">{listing.location || 'Anywhere'}</p>{/if}
    {#if bitcoin}<p class="detail-quote">{bitcoin.sats.toLocaleString() + ' sats · ' + fiatMethodLabel(bitcoin.method)}</p>{/if}
    {#if author}<span hidden use:place={() => author}></span>{/if}
    {#if hasAdded || expiry !== null}
      <p class="listing-dates small muted">{#if hasAdded}<time datetime={addedAt.toISOString()} title={addedAt.toLocaleString()}>{`Added ${dateLabel(addedAt)}`}</time>{/if}{#if hasAdded && expiry !== null}{' · '}{/if}{#if expiry !== null}<time datetime={new Date(listing.expiration * 1000).toISOString()}>{expiry}</time>{/if}</p>
    {/if}
    {#if draftPreview}
      <span hidden use:place={() => description}></span>
    {:else}
      {#snippet actions()}
        <div class="detail-actions">
          {#if showBuy}<button class="button primary" onclick={() => onBuy(listing)}>{bitcoin ? (listing.side === 'request' ? 'Message buyer' : 'Message seller') : listing.side === 'request' ? 'Respond' : 'Buy'}</button>{/if}
          {#if showEdit}<button class="button primary" onclick={() => onEdit(listing)}>Edit listing</button>{/if}
          {#if showClose}
            <details class="account-option">
              <summary>Close offer</summary>
              <p class="small muted">People will no longer be able to take this quote.</p>
              <button class="button secondary" type="button" disabled={closing} onclick={closeOffer}>Close offer</button>
              <p class="error small" role="alert">{problem}</p>
            </details>
          {/if}
          <button class="button secondary" aria-pressed={saved} onclick={() => onSave(listing)}>{saved ? '♥ Saved' : '♡ Save'}</button>
          {#if validListingId(listing.id)}<Share url={listingURL(listing.id)} {onToast} />{/if}
        </div>
      {/snippet}
      {#if listing.externalOrder}
        <dl class="order-terms">{#each terms as [label, value]}<dt>{label}</dt><dd>{value}</dd>{/each}</dl>
        {@render actions()}
      {:else}
        <span hidden use:place={translation}></span>
        {@render actions()}
        <span hidden use:place={() => description}></span>
      {/if}
    {/if}
    {#if isPreview && !draftPreview}<p class="small muted">Sample listing</p>{/if}
  </div>
  {#if raw}
    <details class="listing-raw-event">
      <summary>Raw event</summary>
      <div class="listing-raw-tools"><button class="text-button" type="button" onclick={copyEvent}>Copy event</button><span class="small muted" role="status">{copyStatus}</span></div>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre tabindex="0" aria-label="Raw public event"><code>{raw}</code></pre>
    </details>
  {/if}
</article>
