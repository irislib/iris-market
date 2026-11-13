<script lang="ts">
  import {fiatMethodLabel} from '../escrow-offer.ts'
  import {listingMenu} from '../listing-visibility.ts'
  import {translateListingTitle} from '../translation-content.ts'
  import {place} from '../svelte/place.ts'
  import Price from './Price.svelte'
  import type {CardContext} from './card.ts'

  let {listing: l, ctx}: {listing: any; ctx: CardContext} = $props()
  // The card is rebuilt whenever its key (price, saved, hidden) changes, so these are fixed per mount.
  const saved = ctx.saved(l.id)
  const href = ctx.href(l)
  const bitcoin = !!l.externalOrder || l.escrow?.trade === 'bitcoin_fiat'
  let title = $state(l.title)

  function follow(event: MouseEvent) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    ctx.open(l)
  }
  // Translation updates the title text in place and reports the new value.
  function translate(article: HTMLElement) {
    if (l.externalOrder) return
    const link = article.querySelector<HTMLElement>('.card-title')
    article.append(translateListingTitle(l, link, value => { title = value }))
  }
</script>

<article class="listing-card" class:bitcoin-order-listing={!!l.externalOrder} use:translate>
  <div class="card-image">
    <a class="card-open" aria-label="View {title}" {href} onclick={follow}>
      {#if l.externalOrder}
        <div class="bitcoin-card-quote"><strong>₿</strong><span>{l.externalOrder.platform}</span></div>
      {:else if l.escrow?.trade === 'bitcoin_fiat' && !l.imageUrl}
        <div class="bitcoin-card-quote"><strong>{l.escrow.sats.toLocaleString() + ' sats'}</strong><span>{fiatMethodLabel(l.escrow.method)}</span></div>
      {:else}
        <span hidden use:place={() => ctx.photo(l)}></span>
      {/if}
    </a>
    <button class="save-button" aria-label="{saved ? 'Unsave' : 'Save'} {title}" aria-pressed={saved} onclick={() => ctx.save(l)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.4 5.4 0 0 0-7.6 0L12 5.8l-1.2-1.2a5.4 5.4 0 0 0-7.6 7.6L12 21l8.8-8.8a5.4 5.4 0 0 0 0-7.6Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill={saved ? 'currentColor' : 'none'}/></svg>
    </button>
    {#if bitcoin}<span class="request-badge">{l.side === 'request' ? 'Buying bitcoin' : 'Selling bitcoin'}</span>
    {:else if l.side === 'request'}<span class="request-badge">Buying</span>{/if}
  </div>
  <div class="card-title-row">
    <a class="card-title" {href} onclick={follow}>{l.title}</a>
    <span hidden use:place={() => listingMenu(l.title, ctx.hidden(l.id), () => ctx.toggleHidden(l))}></span>
  </div>
  <Price quote={ctx.quote(l)} info={ctx.price(l)} className="card-price" />
  <p class="card-location">{l.externalOrder?.methods || l.location || 'Anywhere'}</p>
  {#if !ctx.preview() && l.author && !l.externalOrder}
    <span hidden use:place={() => ctx.author(l)}></span>
  {/if}
</article>
