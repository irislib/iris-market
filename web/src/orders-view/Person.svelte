<script lang="ts">
  import {createUserRow, warmProfiles} from '../people.ts'
  import {place} from '../svelte/place.ts'
  import type {OrdersState} from './state.svelte.ts'

  let {orders: s, pubkey, label}: {orders: OrdersState; pubkey: string; label?: string} = $props()

  const row = (key: string) => () => { warmProfiles([key]); return createUserRow(key, {size: 32, onClick: () => s.openProfile(key)}) }
</script>

<div class="order-person">
  {#if label}<span class="small muted">{label}</span>{/if}
  {#if pubkey}{#key pubkey}<span hidden use:place={row(pubkey)}></span>{/key}{/if}
</div>
