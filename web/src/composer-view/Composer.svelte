<script lang="ts">
  import {EXPIRY_CHOICES} from '../expiry.ts'
  import {COUNTRY_CODES} from '../shipping.ts'
  import {place} from '../svelte/place.ts'
  import type {ComposerState} from './state.svelte.ts'
  import Preview from './Preview.svelte'

  let {composer: c}: {composer: ComposerState} = $props()
  const countryNames = new Intl.DisplayNames([navigator.language || 'en'], {type: 'region'})
  const sides = [['offer', 'Selling'], ['request', 'Buying']]
  let sideButtons: HTMLButtonElement[] = $state([])

  /** Appends a node built elsewhere after this element's own children. */
  function append(node: HTMLElement, child: HTMLElement) { node.append(child) }

  function sideKey(event: KeyboardEvent, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index
    c.chooseSide(sides[next][0]); sideButtons[next].focus()
  }
  function submit(event: SubmitEvent) { event.preventDefault(); c.review() }
</script>

<button class="dialog-close icon-button" id="post-close" aria-label="Close listing editor" onclick={() => c.dialog.close()}>×</button>
<h2 bind:this={c.headingNode}>{c.heading}</h2>
<form id="post-form" bind:this={c.form} hidden={c.reviewing} onsubmit={submit} oninput={event => c.input(event)}>
  <div class="post-side-tabs" role="radiogroup" aria-label="Listing type">
    {#each sides as [value, label], index}
      <button type="button" role="radio" data-post-side={value} aria-checked={c.side === value} tabindex={c.side === value ? 0 : -1} disabled={c.busy}
        bind:this={sideButtons[index]} onclick={() => c.chooseSide(value)} onkeydown={event => sideKey(event, index)}>{label}</button>
    {/each}
  </div>
  <input type="hidden" name="side" value={c.side} disabled={c.busy}>
  <label>Category<select name="category" disabled={c.busy} onchange={() => c.syncAreaEditor()}><option value="other">Other</option><option value="home">Home</option><option value="tech">Tech</option><option value="services">Services</option><option value="transport">Transport</option><option value="work">Work</option></select></label>
  <label id="post-transport-type" hidden={c.category !== 'transport'}>Transport type<select name="transportType" disabled={c.controls.transportDisabled}><option value="">Not specified</option><option value="parcel">Delivery</option><option value="passenger">Passenger ride</option><option value="both">Both</option></select></label>
  <label>Title<input name="title" maxlength="160" required autocomplete="off" disabled={c.busy}></label>
  <label>Description<textarea name="description" rows="4" maxlength="12000" disabled={c.busy}></textarea></label>
  <div class="form-pair"><label>Price<input name="price" inputmode="decimal" placeholder="Negotiable" disabled={c.busy}></label><label>Currency<input name="currency" maxlength="12" autocapitalize="characters" disabled={c.busy}></label></div>
  <label>Location <span class="muted">· optional</span><input name="location" maxlength="160" placeholder="City, area or #geohash" autocomplete="off" disabled={c.busy}></label>
  <details class="post-service-areas" hidden={c.areaHidden} bind:this={c.areaEditor} ontoggle={() => c.syncAreaEditor()} use:append={c.areaPicker.element}><summary>Transport areas</summary></details>
  <details id="post-map-pin" bind:this={c.mapPin}>
    <summary>Map pin</summary>
    <label>Precision<select name="pinPrecision" disabled={c.busy} onchange={() => c.changePrecision()}><option value="3">Region</option><option value="4" selected>District</option><option value="5">City</option><option value="6">Neighborhood</option><option value="7">Block</option><option value="exact">Exact coordinates</option></select></label>
    <label>Coordinates or geohash<input name="pinCoordinates" maxlength="80" placeholder="Latitude, longitude or #geohash" autocomplete="off" disabled={c.busy} oninput={() => c.changePin()}></label>
    <button id="post-add-area" class="text-button" type="button" disabled={c.busy} onclick={() => c.useLocation()}>Use my location</button>
    <p class="small muted" id="post-pin-hint">{c.pinHint}</p>
  </details>
  <label>Tags <span class="muted">· optional</span><input name="tags" maxlength="488" autocomplete="off" disabled={c.busy}></label>
  <details>
    <summary>Delivery</summary>
    <label><input type="checkbox" name="shippingEnabled" disabled={c.busy} onchange={() => c.toggleDelivery()}> Offer delivery</label>
    <p class="small muted" id="post-delivery-hint">{c.deliveryHint}</p>
    <button type="button" id="post-remove-delivery" class="text-button" hidden={!c.canRemoveDelivery} disabled={c.busy} onclick={() => c.removeDelivery()}>Remove existing delivery</button>
    <fieldset id="post-delivery-fields" hidden={!c.shippingEnabled} disabled={c.controls.deliveryDisabled}>
      <legend class="sr-only">Delivery destinations and cost</legend>
      <label>Delivers to<select id="post-country-add" disabled={c.busy} onchange={event => c.addCountry(event.currentTarget)}><option value="">Add a country…</option>{#each COUNTRY_CODES as code}<option value={code} disabled={c.countries.includes(code)}>{countryNames.of(code)} ({code})</option>{/each}</select></label>
      <div id="post-delivery-countries">
        {#each c.countries as code (code)}
          <button type="button" class="text-button" aria-label="Remove {countryNames.of(code)}" disabled={c.busy} onclick={() => c.removeCountry(code)}>{countryNames.of(code)} ×</button>
        {/each}
      </div>
      <label>Delivery cost<input name="shippingPrice" inputmode="decimal" placeholder="0 for free delivery" disabled={c.busy}></label>
      <p class="small muted">In the listing currency. Your location is separate.</p>
    </fieldset>
  </details>
  <label>Expires in<select name="expiration" disabled={c.busy}>{#each EXPIRY_CHOICES as option}<option value={option.value}>{option.label}</option>{/each}<option value="keep" hidden={!c.editing} disabled={c.controls.keepDisabled}>{c.keepLabel}</option></select></label>
  <label>Photos & files<input id="post-files" type="file" multiple aria-describedby="post-file-help" disabled={c.busy} onchange={event => c.addFiles(event.currentTarget)}></label>
  <p id="post-file-help" class="small muted">Up to 4 files · 8 MB each</p>
  <ul id="post-file-list" class="post-file-list">
    {#each c.files as entry, index}
      <li><span>{entry.file.name}</span><button type="button" class="text-button" disabled={c.busy} aria-label="Remove {entry.file.name}" onclick={() => c.removeFile(index)}>Remove</button></li>
    {/each}
  </ul>
  <details class="post-image-link"><summary>Image link</summary><label><span class="sr-only">Image link</span><input name="image" type="url" placeholder="https://…" autocomplete="off" disabled={c.busy}></label></details>
  <button id="post-submit" class="button primary" disabled={c.busy}>Preview listing</button>
</form>
<section id="post-preview" hidden={!c.reviewing}>
  <div id="post-preview-content">
    {#if c.preview}
      {#key c.preview}
        {#if c.preview.delivery}<p class="small muted">{c.preview.delivery}</p>{/if}
        <Preview draft={c.preview.draft} files={c.preview.files} priceNode={c.options.priceNode} mediaArea={c.preview.areaInMedia ? c.preview.area?.element : undefined} />
        {#if c.preview.area && !c.preview.areaInMedia}<span hidden use:place={() => c.preview.area.element}></span>{/if}
      {/key}
    {/if}
  </div>
  <p class="small muted">Your listing and attached files will be public.</p>
  <div class="post-preview-actions">
    <button id="post-edit" type="button" class="button secondary" disabled={c.busy} onclick={() => c.editDraft()}>Edit</button>
    <button id="post-publish" type="button" class="button primary" disabled={c.busy} onclick={() => c.publish()}>{c.publishLabel}</button>
  </div>
</section>
<p id="post-progress" class="small muted" role="status">{c.progress}</p>
<p id="post-error" class="error" role="alert">{c.error}</p>
