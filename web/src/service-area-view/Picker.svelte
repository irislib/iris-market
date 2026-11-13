<script lang="ts">
  import {MIN_SERVICE_AREA_RADIUS_KM, MAX_SERVICE_AREA_RADIUS_KM} from '../service-area.ts'
  import {labels, type ServiceAreaPickerState} from './state.svelte.ts'

  let {picker: p}: {picker: ServiceAreaPickerState} = $props()
  const roles = ['pickup', 'destination'] as const
</script>

<div class="service-area-tabs segments" role="group" aria-label="Service area">
  {#each roles as role (role)}
    <button type="button" aria-pressed={role === p.active ? 'true' : 'false'} class:selected={role === p.active} onclick={() => p.selectRole(role)}>{labels[role]}</button>
  {/each}
</div>
<label class="service-area-same" hidden={p.readOnly}><input type="checkbox" checked={p.samePickup} onchange={event => p.setSame(event.currentTarget.checked)}><span>Same as pickup</span></label>
<label hidden={p.readOnly}><input bind:this={p.search} type="search" maxlength="160" placeholder="Search places" autocomplete="off" aria-label="Search places" oninput={() => p.onSearch()}></label>
<div class="service-area-suggestions" role="group" aria-label="Place suggestions">
  {#each p.suggestions as suggestion}<button class="button secondary" type="button" onclick={suggestion.choose}>{suggestion.label}</button>{/each}
</div>
<p class="small muted" role="status">{p.searchStatus}</p>
<div class="service-area-tools" hidden={p.readOnly}>
  <label class="service-area-radius"><span>Radius (km)</span><input bind:this={p.radius} type="number" min={String(MIN_SERVICE_AREA_RADIUS_KM)} max={String(MAX_SERVICE_AREA_RADIUS_KM)} step="0.1" value="10" disabled={p.readOnly || p.linked} onchange={() => p.onRadius()}></label>
  <button class="button secondary" type="button" disabled={p.readOnly || !p.map || p.linked} onclick={() => p.overlay?.pickCenter()}>Use map center</button>
  <button class="locate-button" type="button" aria-label="Use my location for service area" title="Use my location" aria-busy={p.locateBusy ? 'true' : undefined} disabled={p.readOnly || p.linked} onclick={() => p.locate()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v3m0 14v3M2 12h3m14 0h3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg></button>
  <button class="text-button" type="button" disabled={p.readOnly || !p.selected} onclick={() => p.clear()}>Clear area</button>
</div>
<p class="small muted">{p.selection}</p>
<div class="service-area-map" bind:this={p.canvas}></div>
<p class="small muted" role="status" bind:this={p.message}></p>
<p class="error small" role="alert">{p.error}</p>
<button class="button secondary" type="button" hidden={p.retryHidden} onclick={() => p.retry()}>Retry map</button>
{#if !p.readOnly}<p class="small muted">These boundaries will be public when you post.</p>{/if}
