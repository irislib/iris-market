<script lang="ts">
  import type {DeliveryPlaceState} from './place-state.svelte.ts'

  let {place: p, address = ''}: {place: DeliveryPlaceState; address?: string} = $props()
</script>

<label><span>{p.label}</span><input bind:this={p.input} type="text" maxlength="500" required autocomplete="off" placeholder="Address or meeting point" value={address} aria-label={`${p.label} address or meeting point`} oninput={p.searchAddress}></label>
<div class="service-area-suggestions" role="group" aria-label={`${p.label} suggestions`}>
  {#each p.suggestions as suggestion}<button class="button secondary" type="button" onclick={suggestion.choose}>{suggestion.label}</button>{/each}
</div>
<div class="service-area-tools">
  <button class="locate-button" type="button" title="Use my location" aria-label={`Use my location for ${p.label.toLowerCase()}`} aria-busy={p.locateBusy ? 'true' : undefined} onclick={() => p.locate()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v3m0 14v3M2 12h3m14 0h3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg></button>
  <button class="text-button" type="button" hidden={!p.point} onclick={() => p.clear()}>Clear map point</button>
</div>
<p class="small muted" role="status">{p.status}</p>
<details bind:this={p.details} ontoggle={p.openMap}>
  <summary>Map</summary>
  <p class="small muted">Choose a point, or move the map and use its center.</p>
  <div class="service-area-map" bind:this={p.canvas}></div>
  <button class="button secondary" type="button" disabled={!p.mapReady} onclick={() => p.overlay?.pickCenter()}>Use map center</button>
</details>
