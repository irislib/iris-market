<script lang="ts">
  import {place} from '../svelte/place.ts'
  import {insert, collect} from './actions.ts'
  import type {OrdersState} from './state.svelte.ts'
  import {ORDER_PERIODS, ORDER_STATUS_FILTERS, orderTotals} from './summary.ts'
  import {linePrice, orderPrice} from './summary.ts'
  import Person from './Person.svelte'

  let {orders: s}: {orders: OrdersState} = $props()

  const all = $derived.by(() => { void s.renders; return s.filteredOrders() })
  const rows = $derived.by(() => { void s.renders; void s.period; void s.statusFilter; return s.visibleOrders() })
  const totals = $derived(orderTotals(rows))
  const tab = $derived(s.tab)
  const groups = $derived.by(() => { void s.renders; void s.basketVersion; return tab === 'purchases' ? s.basket?.groups() ?? [] : [] })
  const filterable = $derived(['purchases', 'sales', 'archived'].includes(tab) && all.length > 0)

  function courierWorkspace(anchor: HTMLElement) {
    const ui = s.courierUI!
    anchor.before(ui.element)
    ui.show()
    return {destroy() { ui.element.remove() }}
  }
</script>

{#key s.renders + ':' + s.basketVersion}
  {#if groups.length}
    <section class="order-basket" aria-label="Basket">
      <h3>Basket</h3>
      {#each groups as group (group.seller)}
        <div class="order-basket-group">
          <Person orders={s} pubkey={group.seller} label="Seller" />
          {#each group.items as item (item.listing.id)}
            <div class="order-basket-row">
              <span>{item.listing.title}</span>
              <span class="order-basket-quantity">
                <button type="button" class="icon-button" aria-label="One fewer {item.listing.title}" onclick={() => { s.basket!.setQuantity(item.listing.id, item.quantity - 1); s.basketChanged() }}>−</button>
                <span>{item.quantity}</span>
                <button type="button" class="icon-button" aria-label="One more {item.listing.title}" onclick={() => { s.basket!.setQuantity(item.listing.id, item.quantity + 1); s.basketChanged() }}>+</button>
              </span>
              <span>{linePrice({...item.listing, quantity: item.quantity}, value => s.price(value))}</span>
            </div>
          {/each}
          {#if group.items.length > 1}<p class="order-basket-row order-basket-total"><span>Total</span><span>{orderPrice({items: group.items.map(item => ({...item.listing, quantity: item.quantity}))}, value => s.price(value))}</span></p>{/if}
          <button type="button" class="button primary" onclick={() => s.checkoutBasket(group.seller)}>Request order</button>
        </div>
      {/each}
    </section>
  {/if}
{/key}
{#key s.renders}
  {#if tab === 'escrow' && s.escrow}
    <span hidden use:insert={() => collect(host => s.escrow.jobs(host))}></span>
  {:else if tab === 'deliveries' && s.courierUI}
    <span hidden use:courierWorkspace></span>
  {:else if filterable && !rows.length}
    {@render tools()}
    <div class="orders-empty"><h3>No orders match</h3><p class="muted">Try another period or status.</p></div>
  {:else if !rows.length}
    <div class="orders-empty">
      <h3>{tab === 'archived' ? 'Nothing archived' : tab === 'deliveries' ? 'No deliveries yet' : tab === 'sales' ? 'No sales yet' : 'No purchases yet'}</h3>
      <p class="muted">{tab === 'deliveries' ? 'Deliveries you handle appear here.' : tab === 'archived' ? 'Finished orders can be archived without removing their history.' : tab === 'sales' ? 'Order requests for your listings will appear here.' : 'Your orders will appear here.'}</p>
    </div>
  {:else}
    {#if filterable}{@render tools()}{/if}
    <div class="orders-list">
      {#each rows as order}<span hidden use:place={() => s.card(order)}></span>{/each}
    </div>
  {/if}
{/key}

{#snippet tools()}
  <div class="orders-tools">
    <label><span class="sr-only">Period</span><select bind:value={s.period}>{#each ORDER_PERIODS as [value, label]}<option {value}>{label}</option>{/each}</select></label>
    <label><span class="sr-only">Status</span><select bind:value={s.statusFilter}>{#each ORDER_STATUS_FILTERS as [value, label]}<option {value}>{label}</option>{/each}</select></label>
    <button type="button" class="text-button" disabled={!rows.length} onclick={() => s.exportCsv()}>Export CSV</button>
  </div>
  <p class="small muted orders-summary">{rows.length} {rows.length === 1 ? 'order' : 'orders'}{totals.length ? ' · ' + totals.map(total => s.price({price: String(total.amount), currency: total.currency})).join(' · ') : ''}</p>
{/snippet}
