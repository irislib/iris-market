<script lang="ts">
  import {courierListingType} from '../transport-type.ts'
  import type {CourierListing} from '../courier-ui.ts'
  import type {OrderListing} from '../orders.ts'
  import Person from './Person.svelte'
  import type {OrdersState} from './state.svelte.ts'

  let {orders: s}: {orders: OrdersState} = $props()
  const {courier} = s
  const order = s.current()
  const pickup = order?.shipment.stops[0]
  const merchant = order?.seller === s.owner()
  const places = [...s.editors]
  let selectedId = $state('')
  let failedAt = $state(-1)
  let loadingMore = $state(false)
  const pagination = $derived.by(() => { void s.providers; return courier.pagination?.() })

  // Re-read when the public feed changes; the destination editor stays as typed.
  const offers = $derived.by(() => {
    void s.providers
    return courier.getListings().filter((value): value is CourierListing & OrderListing => value.price != null && !!value.currency && value.side === 'offer' && value.author !== order.buyer && value.author !== order.seller && value.status !== 'sold'
      && (!value.expiration || value.expiration > Date.now() / 1000) && ['parcel', 'both'].includes(courierListingType(value) || ''))
  })

  const service = $derived(offers.find(value => value.id === selectedId))
  function editor(anchor: HTMLElement, input: typeof places[number]) {
    anchor.before(input.element)
    return {destroy() { input.destroy(); input.element.remove() }}
  }
  async function more() {
    if (loadingMore || pagination?.loading) return
    loadingMore = true
    try { await courier.loadMore(); s.providers++ }
    catch { failedAt = s.providers }
    finally { loadingMore = false }
  }
  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!service) return
    void s.perform(async () => {
      const result = await s.account.messaging.requestDelivery(order.id, service, places.at(-1).read(), merchant ? places[0].read() : undefined)
      s.data = s.account.state(); s.showDetail(result); s.announce('Delivery requested')
    })
  }
</script>

{#if order && courier && places.length}
  <form class="order-delivery-form" onsubmit={submit}>
    <h3>Choose a delivery service</h3>
    <div class="order-service-options">
      {#each offers as value (value.id)}
        <div class="order-service-row">
          <button type="button" class="button secondary order-service-option" data-order-action disabled={s.busy} aria-pressed={service?.id === value.id} onclick={() => { selectedId = value.id }}>
            <strong>{value.title}</strong><span class="small muted">{s.price(value)}</span>
          </button>
          <Person orders={s} pubkey={value.author} />
        </div>
      {/each}
    </div>
    {#if loadingMore || pagination?.loading}<p class="small muted" role="status">Looking for delivery services…</p>
    {:else if failedAt === s.providers || pagination?.error}<p class="small muted" role="status">Couldn’t load more delivery services.</p>
    {:else if !offers.length}<p class="small muted" role="status">No parcel delivery services found yet.</p>{/if}
    {#if courier.loadMore}<button type="button" class="button secondary" disabled={s.busy || loadingMore || pagination?.loading} onclick={more}>More services</button>{/if}
    {#if merchant && !offers.length}{@render action('Use my own carrier', () => s.openRoute(true))}{/if}
    {#if !merchant}<h3>Pickup</h3><p>{pickup.address}</p>{/if}
    {#each places as input}<span hidden use:editor={input}></span>{/each}
    {#if service}<p class="small muted">{merchant ? 'This courier will receive the pickup and destination. Your buyer receives the courier’s identity and pickup code.' : 'Only this delivery provider receives your destination. The merchant receives their identity and a pickup reference.'}</p>{/if}
    <button type="submit" class="button primary" data-order-action disabled={!service || s.busy}>Request delivery</button>
    {@render action('Back to order', () => s.showDetail(order))}
  </form>
{/if}

{#snippet action(label: string, run: () => void)}
  <button type="button" class="button secondary" data-order-action disabled={s.busy} onclick={run}>{label}</button>
{/snippet}
