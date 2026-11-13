<script lang="ts">
  import {DEFAULT_SUPPORTED_MINTS, isTestMint} from '../wallet/mints.ts'
  import type {OrdersState} from './state.svelte.ts'

  let {orders: s}: {orders: OrdersState} = $props()
  const order = s.current()
  const allowed = !!order && !order.escrowTradeId && order.seller === s.owner()
  const initial = allowed && ['SATS', 'TESTSAT'].includes(order.items[0].currency) ? order.items[0].price : ''
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
    <label>Mint<select bind:this={mint} aria-label="Payment mint">
      {#each DEFAULT_SUPPORTED_MINTS as url}<option value={url}>{new URL(url).hostname + (isTestMint(url) ? ' · Test money' : '')}</option>{/each}
    </select></label>
    <button type="submit" class="button primary" data-order-action disabled={s.busy}>Request payment</button>
    <button type="button" class="button secondary" data-order-action disabled={s.busy} onclick={() => s.showDetail(order)}>Cancel</button>
  </form>
{/if}
