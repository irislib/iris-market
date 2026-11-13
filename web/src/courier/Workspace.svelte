<script lang="ts">
  import {place} from '../svelte/place.ts'
  import type {CourierListing, CourierType} from '../courier-ui.ts'
  import type {CourierWorkspaceState} from './state.svelte.ts'

  let {workspace: w}: {workspace: CourierWorkspaceState} = $props()
  const o = w.options
  const types = [['parcel', 'Deliveries'], ['passenger', 'Rides'], ['both', 'Both']] as const
  const sections = [['work', 'Find work'], ['jobs', 'My jobs'], ['service', 'My service']] as const
  const typeButtons: HTMLButtonElement[] = []
  const v = $derived(w.view)

  function keydown(event: KeyboardEvent, key: CourierType) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const keys: CourierType[] = ['parcel', 'passenger', 'both'], index = keys.indexOf(key)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : 2)) % 3
    w.chooseType(keys[next])
    typeButtons[next]?.focus()
  }
  function submit(event: SubmitEvent) { event.preventDefault(); w.submit() }
</script>

{#snippet card(listing: CourierListing)}
  {#if o.renderListing}<span hidden use:place={() => o.renderListing(listing)}></span>
  {:else}<button class="order-card" type="button" onclick={() => o.onListing(listing)}><span class="order-card-copy"><span class="order-card-title">{listing.title}</span><span class="small muted">{listing.location || 'Area not specified'}</span></span></button>{/if}
{/snippet}

<nav class="orders-tabs courier-tabs" aria-label="Transport">
  {#each sections as [key, label] (key)}<button type="button" aria-pressed={v.section === key ? 'true' : 'false'} onclick={() => w.openSection(key)}>{label}</button>{/each}
</nav>
<form class="courier-controls" hidden={v.section === 'jobs'} onsubmit={submit}>
  <div class="segments courier-types" role="radiogroup" aria-label="Transport type">
    {#each types as [key, label], index (key)}
      <button bind:this={typeButtons[index]} type="button" role="radio" aria-checked={w.type === key ? 'true' : 'false'} class:selected={w.type === key} tabindex={w.type === key ? 0 : -1} onclick={() => w.chooseType(key)} onkeydown={event => keydown(event, key)}>{label}</button>
    {/each}
  </div>
  <label class="courier-area"><span>{v.section === 'service' ? 'Area name (optional)' : 'Area'}</span><input bind:this={w.area} type={v.section === 'service' ? 'text' : 'search'} maxlength="160" placeholder="City or area" autocomplete="off"></label>
  <button class="button secondary" type="submit" disabled={v.section === 'service' && v.preview} use:place={() => w.picker.element}>{v.section === 'service' ? 'Offer service' : 'Apply'}</button>
</form>
<p class="error small" role="alert">{w.notice}</p>
<div class="courier-content">
  {#key v}
    {#if v.section === 'jobs'}
      {#if !v.owner}<button class="button primary" type="button" onclick={o.onSignIn}>Sign in to see your jobs</button>
      {:else}
        <div class="orders-list">
          {#if !v.active.length && !v.finished.length}<h3>No jobs yet</h3><p class="small muted">Deliveries and rides assigned to you appear here.</p>
          {:else}
            {#if v.active.length}<h3>Active · {v.active.length}</h3>{#each v.active as order}<span hidden use:place={() => o.renderOrder(order)}></span>{/each}{/if}
            {#if v.finished.length}<h3>History</h3>{#each v.finished as order}<span hidden use:place={() => o.renderOrder(order)}></span>{/each}{/if}
          {/if}
        </div>
      {/if}
    {:else if v.preview}<p class="muted">Switch to the live market to find work or offer a service.</p>
    {:else if v.section === 'service'}
      {#if v.owner}<button class="text-button" type="button" onclick={() => o.onReviews(v.owner)}>My reviews</button>{/if}
      {#if v.rows.length}
        <h3>Your listings</h3>
        <div class="courier-services">
          {#each v.rows as listing}
            <div class="courier-service">{@render card(listing)}{#if o.onEditListing}<button class="text-button" type="button" onclick={() => o.onEditListing(listing)}>Edit listing</button>{/if}</div>
          {/each}
        </div>
      {/if}
    {:else if !v.rows.length}<h3>No matching requests</h3><p class="small muted">{v.filtered ? 'Try another area or a different transport type.' : 'Delivery and ride requests will appear here.'}</p>
    {:else}
      <div class={o.renderListing ? 'listing-grid courier-grid' : 'orders-list courier-grid'}>{#each v.rows.slice(0, v.limit) as listing}{@render card(listing)}{/each}</div>
    {/if}
  {/key}
</div>
<button class="button secondary courier-more" type="button" hidden={w.more.hidden} disabled={w.more.disabled} onclick={() => w.loadMore()}>{w.more.text}</button>
