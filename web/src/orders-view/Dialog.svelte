<script lang="ts">
  import type {OrdersState} from './state.svelte.ts'
  import History from './History.svelte'
  import Detail from './Detail.svelte'
  import Review from './Review.svelte'
  import Route from './Route.svelte'
  import Delivery from './Delivery.svelte'
  import Payment from './Payment.svelte'

  let {orders: s}: {orders: OrdersState} = $props()

  const heading = $derived(s.view === 'delivery' ? 'Arrange delivery' : s.view === 'payment' ? 'Request payment' : s.view === 'review' ? 'Request an order'
    : s.view === 'route' ? 'Delivery details' : s.view === 'detail' ? 'Order details' : s.tab === 'deliveries' ? 'Transport' : 'Orders')
  const sections = $derived.by(() => { void s.renders; return s.sections() })
</script>

<button type="button" class="dialog-close icon-button" aria-label="Close orders" onclick={() => s.dialog.close()}>×</button>
<button type="button" class="text-button orders-back" hidden={s.view === 'history'} onclick={() => s.showHistory()}>← Orders</button>
<h2 id="orders-title">{heading}</h2>
<nav class="orders-tabs" aria-label="Order history" hidden={s.view !== 'history' || !!s.courier && s.tab === 'deliveries'}>
  {#each sections as [key, label] (key)}
    <button type="button" aria-pressed={s.tab === key} onclick={() => s.showTab(key)}>{label}</button>
  {/each}
</nav>
<p class="error orders-error" role="alert">{s.error}</p>
<div class="orders-body">
  {#if s.view === 'detail'}
    <Detail orders={s} />
  {:else if s.view === 'history'}
    <History orders={s} />
  {:else}
    {#key s.renders}
      {#if s.view === 'review'}<Review orders={s} />
      {:else if s.view === 'route'}<Route orders={s} />
      {:else if s.view === 'delivery'}<Delivery orders={s} />
      {:else if s.view === 'payment'}<Payment orders={s} />{/if}
    {/key}
  {/if}
</div>
<p class="orders-announcement sr-only" role="status">{s.announcement}</p>
