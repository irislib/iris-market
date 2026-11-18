<script lang="ts">
  import type {OrderView} from '../orders.ts'
  import type {OrdersState} from './state.svelte.ts'
  import {dateTime} from './format.ts'
  import HandoffCode from './HandoffCode.svelte'
  let {orders,order}:{orders:OrdersState;order:OrderView}=$props()
  const receipt=$derived(order.pickupReceipt),role=$derived(order.pickupReceiptRole)
  const active=$derived(order.status==='accepted'||order.status==='in-transit')
  let busy=$state(false),error=$state(''),stale=$state(false)
  $effect(()=>{
    const until=receipt && receipt.confirmedAt==null?(receipt.collectedAt+120)*1000-Date.now():undefined
    stale=until!=null && until<=0
    if(until>0){const timer=setTimeout(()=>{stale=true},until);return ()=>clearTimeout(timer)}
  })
  async function readAcknowledgment(code:string) {
    if(!code.startsWith('iris-handoff:2:pickup:'))throw Error('Ask for the signed pickup acknowledgment.')
    return orders.account.messaging.checkOrderHandoff(order.id,'pickup',code)
  }
  async function act(confirm=false) {
    if(busy)return
    busy=true;error=''
    try{
      if(confirm)await orders.account.messaging.confirmOrderPickup(order.id)
      else await orders.account.messaging.acknowledgeOrderPickup(order.id)
      orders.render()
    }catch(cause){error=cause.message}
    finally{busy=false}
  }
</script>
<section class="pickup-receipt" aria-labelledby="pickup-receipt-heading">
  <h3 id="pickup-receipt-heading">Pickup receipt</h3>
  {#if receipt?.state==='confirmed'}
    <p role="status"><strong>Pickup confirmed</strong></p>
    <p class="small">Collector acknowledged · {dateTime(receipt.collectedAt)}</p>
    <p class="small">Merchant confirmed · {dateTime(receipt.confirmedAt)}</p>
    <HandoffCode {orders} label="Show receipt QR" imageLabel="Signed pickup receipt"
      description="Share this signed receipt only with someone involved in this pickup."
      showCode={()=>orders.account.messaging.showPickupReceipt(order.id)} />
  {:else if role}
    {#if receipt}
      <p>Collector acknowledged · {dateTime(receipt.collectedAt)}</p>
    {/if}
    {#if role==='collector' && active}
      {#if !receipt || stale}
        <p class="small">{stale?'The acknowledgment expired before confirmation.':'Acknowledge when you receive the item.'}</p>
        <button class="button primary" type="button" disabled={busy} onclick={()=>act()}>{stale?'Renew acknowledgment':'Acknowledge pickup'}</button>
      {:else}
        <p class="small" role="status">Waiting for merchant confirmation.</p>
        <HandoffCode {orders} label="Show pickup QR" imageLabel="Signed pickup acknowledgment" expires
          description="Show the merchant if either device is offline. Valid for two minutes."
          showCode={()=>orders.account.messaging.acknowledgeOrderPickup(order.id)} />
      {/if}
    {:else if role==='merchant' && active}
      {#if receipt && !stale}
        <button class="button primary" type="button" disabled={busy} onclick={()=>act(true)}>Confirm handover</button>
      {:else}
        <p class="small">{stale?'Ask the collector to acknowledge pickup again.':'Waiting for the collector to acknowledge pickup.'}</p>
        <HandoffCode {orders} label="Scan pickup acknowledgment" readCode={readAcknowledgment} />
      {/if}
    {:else if role==='observer' && !receipt}
      <p class="small">The signed receipt will appear here after pickup.</p>
    {/if}
    {#if role!=='merchant'}
      <details><summary>Receive receipt offline</summary>
        <HandoffCode {orders} label="Scan receipt QR" readCode={value=>orders.account.messaging.verifyPickupReceipt(order.id,value)} />
      </details>
    {/if}
  {/if}
  {#each order.previousPickupReceipts??[] as previous (previous.reference)}
    <details><summary>Earlier pickup · {dateTime(previous.confirmedAt)}</summary>
      <p class="small">Collector acknowledged · {dateTime(previous.collectedAt)}</p>
      <p class="small">Merchant confirmed · {dateTime(previous.confirmedAt)}</p>
      <HandoffCode {orders} label="Show earlier receipt QR" imageLabel="Earlier signed pickup receipt"
        showCode={()=>orders.account.messaging.showPickupReceipt(order.id,previous.reference)} />
    </details>
  {/each}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>
<style>
  .pickup-receipt { display:grid;justify-items:start;gap:.45rem; }
  .pickup-receipt p,.pickup-receipt h3 { margin:0; }
  details summary {cursor:pointer}
</style>
