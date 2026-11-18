<script lang="ts">
  import type {HandoffAction} from '../order-handoff.ts'
  import type {OrdersState} from './state.svelte.ts'
  import HandoffCode from './HandoffCode.svelte'
  let {orders,orderId,item}: {orders:OrdersState;orderId:string;item:HandoffAction}=$props()
  const name=$derived(item.kind==='pickup'?'pickup':'drop-off')
</script>
{#if item.action==='checked'}
  <p class="handoff-checked" role="status">{item.kind==='pickup'?'Pickup':'Drop-off'} verified on this device</p>
{:else if item.action==='show'}
  <HandoffCode {orders} label={'Show '+name+' code'} imageLabel={'Signed '+name+' code'}
    description={'Show this only at '+name+'. Valid for two minutes.'} expires
    showCode={()=>orders.account.messaging.showOrderHandoff(orderId,item.kind)} />
{:else}
  <HandoffCode {orders} label={'Scan '+name+' code'} readCode={value=>orders.account.messaging.checkOrderHandoff(orderId,item.kind,value)} />
{/if}
<style>.handoff-checked { font-weight:600; }</style>
