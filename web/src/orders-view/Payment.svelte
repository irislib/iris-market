<script lang="ts">
  import {DEFAULT_SUPPORTED_MINTS, configuredLocalTestMint, isTestMint} from '../wallet/mints.ts'
  import type {OrdersState} from './state.svelte.ts'
  import {orderPrice} from './summary.ts'

  let {orders: s}: {orders: OrdersState} = $props()
  const order = s.current()
  const allowed = !!order && !order.escrowTradeId && order.seller === s.owner()
  const item = order?.items[0]
  const developerMint = configuredLocalTestMint()
  const mints = developerMint ? [developerMint, ...DEFAULT_SUPPORTED_MINTS] : DEFAULT_SUPPORTED_MINTS
  // Suggest the listing total in sats; the seller can still change it.
  // A basket suggests the sum of its items, when each converts.
  const parts = allowed ? order.items.map(value => s.satsFor(value)) : []
  const suggested = parts.length && parts.every(value => value) ? parts.reduce((sum, value) => sum + value!, 0) : null
  const initial = suggested ? String(suggested) : ''
  const estimate = suggested && !['SATS', 'TESTSAT'].includes(String(item.currency).toUpperCase()) ? `Order total ${orderPrice(order, value => s.price(value))}, converted at today’s rate.` : ''
  let amount: HTMLInputElement, mint: HTMLSelectElement

  function submit(event: SubmitEvent) {
    event.preventDefault()
    void s.perform(async () => {
      await s.account.messaging.updateOrder(order.id, {payment: {amount: amount.value, mint: mint.value, unit: 'sat', status: 'requested'}})
      s.view = 'detail'
    })
  }
</script>

{#if allowed}
  <form class="order-payment-form" onsubmit={submit}>
    <label class="order-field"><span>Amount in sats</span><input bind:this={amount} type="number" value={initial} required min="1" step="1"></label>
    {#if estimate}<p class="small muted">{estimate}</p>{/if}
    <label>Mint<select bind:this={mint} aria-label="Payment mint">
      {#each mints as url}<option value={url}>{new URL(url).hostname + (isTestMint(url) ? ' · Test money' : '')}</option>{/each}
    </select></label>
    <button type="submit" class="button primary" data-order-action disabled={s.busy}>Request payment</button>
    <button type="button" class="button secondary" data-order-action disabled={s.busy} onclick={() => s.showDetail(order)}>Cancel</button>
  </form>
{/if}
