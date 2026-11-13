<script lang="ts">
  import type {Shipment, ShipmentStop} from '../orders.ts'
  import {courierKey, localDateTime} from './format.ts'
  import Person from './Person.svelte'
  import type {OrdersState} from './state.svelte.ts'

  let {orders: s}: {orders: OrdersState} = $props()
  const order = s.current()
  const limit = 12

  interface Row {key: string; value: Partial<ShipmentStop>; assigned?: string; fields: Record<string, HTMLInputElement>}
  let next = 0
  const row = (value: Partial<ShipmentStop> = {}): Row => ({key: String(next++), value, assigned: value.courierPubkey, fields: {}})
  let rows = $state<Row[]>((order.shipment?.stops?.length ? order.shipment.stops : [{label: 'Pickup'}, {label: 'Destination'}]).slice(0, limit).map(row))
  let eta: HTMLInputElement, tracking: HTMLInputElement

  function read({value, assigned, fields}: Row): ShipmentStop {
    const lat = fields.latitude.value.trim(), lon = fields.longitude.value.trim()
    if (!!lat !== !!lon) throw new Error('Enter both latitude and longitude for a map position.')
    const result: ShipmentStop = {id: value.id || crypto.randomUUID(), label: fields.label.value.trim(), address: fields.address.value.trim(), status: value.status || 'pending'}
    if (lat && lon) {
      const coordinates = [Number(lon), Number(lat)]
      if (!coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) throw new Error('Check the map coordinates.')
      result.coordinates = coordinates as [number, number]
    }
    const profile = fields.courier.value.trim()
    if (profile) result.courierPubkey = courierKey(profile); else if (assigned) result.courierPubkey = assigned
    return result
  }

  function submit(event: SubmitEvent) {
    event.preventDefault()
    void s.perform(async () => {
      const shipment: Shipment = {stops: rows.map(read)}
      if (tracking.value.trim()) { const url = new URL(tracking.value.trim()); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a secure tracking link.'); shipment.trackingUrl = url.href }
      if (eta.value) { const at = Date.parse(eta.value); if (!Number.isFinite(at)) throw new Error('Check the expected arrival time.'); shipment.eta = Math.floor(at / 1000) }
      await s.account.messaging.updateOrder(order.id, {shipment}); s.view = 'detail'; s.announce('Delivery saved')
    })
  }
</script>

<form class="order-route-form" onsubmit={submit}>
  <div class="order-route-stops">
    {#each rows as stop, index (stop.key)}
      <fieldset class="order-route-stop">
        <legend>Stop {index + 1}</legend>
        <label class="order-field"><span>Label</span><input bind:this={stop.fields.label} type="text" value={stop.value.label || ''} required maxlength="80" placeholder="Pickup, depot, destination…"></label>
        <label class="order-field"><span>Address</span><input bind:this={stop.fields.address} type="text" value={stop.value.address || ''} maxlength="500" placeholder="Street, city or meeting point"></label>
        <div class="order-route-assignee">
          {#if stop.assigned}
            <Person orders={s} pubkey={stop.assigned} />
            <button type="button" class="text-button" onclick={() => { stop.assigned = undefined }}>Remove courier</button>
          {/if}
        </div>
        <label class="order-field"><span>Courier profile</span><input bind:this={stop.fields.courier} type="text" value="" placeholder="Paste a profile link or user ID (optional)"></label>
        <details class="order-coordinate-fields">
          <summary>Map position</summary>
          <div class="order-field-pair">
            <label class="order-field"><span>Latitude</span><input bind:this={stop.fields.latitude} type="number" value={String(stop.value.coordinates?.[1] ?? '')} min="-90" max="90" step="any"></label>
            <label class="order-field"><span>Longitude</span><input bind:this={stop.fields.longitude} type="number" value={String(stop.value.coordinates?.[0] ?? '')} min="-180" max="180" step="any"></label>
          </div>
        </details>
        <button type="button" class="text-button" onclick={() => { rows.splice(index, 1) }}>Remove stop</button>
      </fieldset>
    {/each}
  </div>
  <button type="button" class="button secondary" data-order-action disabled={s.busy || rows.length >= limit} onclick={() => { if (rows.length < limit) rows.push(row()) }}>Add stop</button>
  <label class="order-field"><span>Expected arrival</span><input bind:this={eta} type="datetime-local" value={localDateTime(order.shipment?.eta)}></label>
  <label class="order-field"><span>Carrier tracking link</span><input bind:this={tracking} type="url" value={order.shipment?.trackingUrl || ''} placeholder="https://…"></label>
  <div class="order-actions">
    <button type="submit" class="button primary" data-order-action disabled={s.busy}>Save delivery</button>
    <button type="button" class="button secondary" data-order-action disabled={s.busy} onclick={() => { s.view = 'detail'; s.error = ''; s.render() }}>Cancel</button>
  </div>
</form>
