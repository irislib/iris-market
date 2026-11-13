<script lang="ts">
  import {translateListingTitle} from '../translation-content.ts'
  import {imageUrl} from '../media.ts'
  import {art} from '../art.ts'
  import type {createDeliveryPlaceInput} from '../delivery-place-ui.ts'
  import {place} from '../svelte/place.ts'
  import Person from './Person.svelte'
  import type {OrdersState} from './state.svelte.ts'

  let {orders: s}: {orders: OrdersState} = $props()
  const {account, escrow} = s
  // A fresh form per render; later listing changes never reset what was typed.
  const listing = s.listing
  const places = [...s.editors]
  const escrowable = !!(escrow && listing?.escrow?.trade === 'goods' && listing.side === 'offer')
  let image = $state(listing ? imageUrl(listing.imageUrl, {width: 160}) || art(listing) : '')
  let fellBack = false
  let protect = $state(false)
  let quantity: HTMLInputElement, note: HTMLTextAreaElement, title: HTMLElement
  const eligible = $derived.by(() => { void s.tools; return escrowable && escrow.canCheckout(listing) })
  $effect.pre(() => { if (escrowable && !eligible) protect = false })

  function editor(anchor: HTMLElement, value: ReturnType<typeof createDeliveryPlaceInput>) {
    anchor.before(value.element)
    return {destroy() { value.destroy(); value.element.remove() }}
  }

  function submit(event: SubmitEvent) {
    event.preventDefault()
    const count = Number(quantity.value), message = note.value.trim()
    if (!Number.isInteger(count) || count < 1 || count > 999) { quantity.reportValidity(); return }
    void s.perform(async () => {
      const draft = {quantity: count, note: message, ...(places.length === 2 ? {deliveryRequest: {pickup: places[0].read(), destination: places[1].read()}} : {})}
      const saved = order => { s.data = account.state(); s.showDetail(order); s.announce('Order requested') }
      if (protect) {
        if (!escrow?.canCheckout(listing)) throw Error('Enable escrow in Settings to use a provider.')
        await escrow.checkout(listing, draft, saved)
      } else saved(await account.messaging.requestOrder(listing, draft))
    })
  }
</script>

{#if listing}
  <form class="order-review" onsubmit={submit}>
    <div class="order-review-item">
      <img alt="" referrerpolicy="no-referrer" src={image} onerror={() => { if (fellBack) return; fellBack = true; image = art(listing) }}>
      <div>
        <h3 bind:this={title}>{listing.title}</h3>
        <p class="order-review-price">{s.price(listing)}</p>
        <span hidden use:place={() => translateListingTitle(listing, title)}></span>
      </div>
    </div>
    <Person orders={s} pubkey={listing.author} label="Seller" />
    {#each places as value}<span hidden use:editor={value}></span>{/each}
    <label class="order-field"><span>Quantity</span><input bind:this={quantity} type="number" value="1" required min="1" max="999" step="1"></label>
    <label class="order-field"><span>Message to the seller</span><textarea bind:this={note} value="" maxlength="2000" placeholder="Optional" rows="3"></textarea></label>
    {#if escrowable}
      <label class="checkbox-label" hidden={!eligible}><input type="checkbox" bind:checked={protect}><span>Use escrow</span></label>
    {/if}
    <p class="small muted">The seller will confirm your request. No payment is taken here.</p>
    <button type="submit" class="button primary" data-order-action disabled={s.busy || listing.author === s.owner()}>{protect ? 'Choose escrow provider' : 'Request order'}</button>
  </form>
{/if}
