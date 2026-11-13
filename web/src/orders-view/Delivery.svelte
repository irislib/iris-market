<script lang="ts">
  import {courierListingType} from '../transport-type.ts'
  import Person from './Person.svelte'
  import type {OrdersState} from './state.svelte.ts'

  let {orders: s}: {orders: OrdersState} = $props()
  const {courier} = s
  const order = s.current()
  const pickup = order?.shipment.stops[0]
  const destination = s.editors[0]
  let service = $state.raw<any>()
  let failedAt = $state(-1)

  // Re-read when the public feed changes; the destination editor stays as typed.
  const offers = $derived.by(() => {
    void s.providers
    return courier.getListings().filter(value => value.side === 'offer' && value.author !== s.owner() && value.author !== order.seller && value.status !== 'sold'
      && (!value.expiration || value.expiration > Date.now() / 1000) && ['parcel', 'both'].includes(courierListingType(value) || ''))
  })

  function editor(anchor: HTMLElement) {
    anchor.before(destination.element)
    return {destroy() { destination.destroy(); destination.element.remove() }}
  }
  function more() {
    const at = s.providers
    void courier.loadMore().then(() => { s.providers++ }).catch(() => { failedAt = at })
  }
  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!service) return
    void s.perform(async () => {
      const result = await s.account.messaging.requestDelivery(order.id, service, destination.read())
      s.data = s.account.state(); s.showDetail(result); s.announce('Delivery requested')
    })
  }
</script>

{#if order && courier && destination}
  <form class="order-delivery-form" onsubmit={submit}>
    <h3>Pickup</h3>
    <p>{pickup.address}</p>
    <span hidden use:editor></span>
    <h3>Choose a delivery service</h3>
    <div class="order-service-options">
      {#each offers as value (value.id)}
        <div class="order-service-row">
          <button type="button" class="button secondary order-service-option" data-order-action disabled={s.busy} aria-pressed={service?.id === value.id} onclick={() => { service = value }}>
            <strong>{value.title}</strong><span class="small muted">{s.price(value)}</span>
          </button>
          <Person orders={s} pubkey={value.author} />
        </div>
      {/each}
    </div>
    <p class="small muted">{failedAt === s.providers ? 'No more services found yet.' : offers.length ? '' : 'Looking for delivery services…'}</p>
    {#if courier.loadMore}{@render action('More services', more)}{/if}
    <p class="small muted">{service ? 'Only this delivery provider receives your destination. The merchant receives their identity and a pickup reference.' : ''}</p>
    <button type="submit" class="button primary" data-order-action disabled={!service || s.busy}>Request delivery</button>
    {@render action('Back to order', () => s.showDetail(order))}
  </form>
{/if}

{#snippet action(label: string, run: () => void)}
  <button type="button" class="button secondary" data-order-action disabled={s.busy} onclick={run}>{label}</button>
{/snippet}
