<script lang="ts">
  import {translateListingTitle} from '../translation-content.ts'
  import {imageUrl} from '../media.ts'
  import {art} from '../art.ts'
  import type {createDeliveryPlaceInput} from '../delivery-place-ui.ts'
  import {place} from '../svelte/place.ts'
  import Person from './Person.svelte'
  import {linePrice, orderPrice} from './summary.ts'
  import type {OrdersState} from './state.svelte.ts'

  let {orders: s}: {orders: OrdersState} = $props()
  const {account, escrow} = s
  // A fresh form per render; later listing changes never reset what was typed.
  const listing = s.listing
  const selection = s.basketSelection
  const lines = selection?.items ?? []
  const firstQuantity = lines[0]?.quantity ?? 1
  const extra = lines.slice(1)
  const places = [...s.editors]
  const escrowable = !!(escrow && listing?.escrow?.trade === 'goods' && listing.side === 'offer')
  let image = $state(listing ? imageUrl(listing.imageUrl, {width: 160}) || art(listing) : '')
  let fellBack = false
  let protect = $state(false)
  let quantity = $state<number | undefined>(firstQuantity)
  let note: HTMLTextAreaElement, title: HTMLElement
  const eligible = $derived.by(() => { void s.tools; return escrowable && escrow.canCheckout(listing) })
  $effect.pre(() => { if (escrowable && !eligible) protect = false })

  function editor(anchor: HTMLElement, value: ReturnType<typeof createDeliveryPlaceInput>) {
    anchor.before(value.element)
    return {destroy() { value.destroy(); value.element.remove() }}
  }

  function submit(event: SubmitEvent) {
    event.preventDefault()
    const count = Number(quantity), message = note.value.trim()
    if (!Number.isInteger(count) || count < 1 || count > 999) { (event.currentTarget as HTMLFormElement).reportValidity(); return }
    void s.perform(async () => {
      const draft = {quantity: count, note: message, ...(extra.length ? {basket: extra.map(item => ({listing: item.listing, quantity: item.quantity}))} : {}), ...(places.length === 2 ? {deliveryRequest: {pickup: places[0].read(), destination: places[1].read()}} : {})}
      const saved = order => {
        if (selection) {
          s.basket?.consume([{id: listing.id, quantity: count}, ...extra.map(item => ({id: item.listing.id, quantity: item.quantity}))], selection.owner)
          s.basketChanged()
        }
        s.data = account.state()
        s.showDetail(order)
        s.announce('Order requested')
      }
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
        {#if extra.length}
          <h3>{lines.reduce((sum, item) => sum + item.quantity, 0)} items</h3>
          <p class="order-review-price">{orderPrice({items: lines.map(item => ({...item.listing, quantity: item.quantity}))}, value => s.price(value))}</p>
        {:else}
          <h3 bind:this={title}>{listing.title}</h3>
          <p class="order-review-price">{quantity && quantity > 1 ? linePrice({...listing, quantity}, value => s.price(value)) : s.price(listing)}</p>
          <span hidden use:place={() => translateListingTitle(listing, title)}></span>
        {/if}
      </div>
    </div>
    <Person orders={s} pubkey={listing.author} label="Seller" />
    {#each places as value}<span hidden use:editor={value}></span>{/each}
    <label class="order-field" hidden={extra.length > 0}><span>Quantity</span><input bind:value={quantity} type="number" required min="1" max="999" step="1"></label>
    {#if extra.length}
      <div class="order-basket-items">
        {#each lines as item (item.listing.id)}<p class="order-basket-row"><span>{item.quantity} × {item.listing.title}</span><span>{linePrice({...item.listing, quantity: item.quantity}, value => s.price(value))}</span></p>{/each}
      </div>
    {/if}
    <label class="order-field"><span>Message to the seller</span><textarea bind:this={note} value="" maxlength="2000" placeholder="Optional" rows="3"></textarea></label>
    {#if escrowable && !extra.length}
      <label class="checkbox-label" hidden={!eligible}><input type="checkbox" bind:checked={protect}><span>Use escrow</span></label>
    {/if}
    <p class="small muted">The seller will confirm your request. No payment is taken here.</p>
    <button type="submit" class="button primary" data-order-action disabled={s.busy || listing.author === s.owner()}>{protect ? 'Choose escrow provider' : 'Request order'}</button>
  </form>
{/if}
