<script lang="ts">
  import {place} from '../svelte/place.ts'
  import {insert, collect} from './actions.ts'
  import type {OrdersState} from './state.svelte.ts'

  let {orders: s}: {orders: OrdersState} = $props()

  const rows = $derived.by(() => { void s.renders; return s.filteredOrders() })
  const tab = $derived(s.tab)

  function courierWorkspace(anchor: HTMLElement) {
    const ui = s.courierUI!
    anchor.before(ui.element)
    ui.show()
    return {destroy() { ui.element.remove() }}
  }
</script>

{#key s.renders}
  {#if tab === 'escrow' && s.escrow}
    <span hidden use:insert={() => collect(host => s.escrow.jobs(host))}></span>
  {:else if tab === 'deliveries' && s.courierUI}
    <span hidden use:courierWorkspace></span>
  {:else if !rows.length}
    <div class="orders-empty">
      <h3>{tab === 'archived' ? 'Nothing archived' : tab === 'deliveries' ? 'No deliveries yet' : tab === 'sales' ? 'No sales yet' : 'No purchases yet'}</h3>
      <p class="muted">{tab === 'deliveries' ? 'Deliveries you handle appear here.' : tab === 'archived' ? 'Finished orders can be archived without removing their history.' : tab === 'sales' ? 'Order requests for your listings will appear here.' : 'Your orders will appear here.'}</p>
    </div>
  {:else}
    <div class="orders-list">
      {#each rows as order}<span hidden use:place={() => s.card(order)}></span>{/each}
    </div>
  {/if}
{/key}
