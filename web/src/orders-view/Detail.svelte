<script lang="ts">
  import {orderContext} from '../message-context.ts'
  import {translateListingTitle} from '../translation-content.ts'
  import {orderReviewParticipants} from '../courier-ui.ts'
  import {stopDirections, transportProgress} from '../transport-job.ts'
  import {renderCashuContent, containsCashu} from '../cashu-content.ts'
  import {isTestMint, mintUnitLabel} from '../wallet/mints.ts'
  import {orderArrival} from '../order-arrival.ts'
  import {insert} from './actions.ts'
  import {dateTime, statuses, terminal, trackingLink} from './format.ts'
  import Person from './Person.svelte'
  import type {OrdersState} from './state.svelte.ts'

  let {orders: s}: {orders: OrdersState} = $props()
  const {account, escrow, courier} = s
  const {onPay, onReceiveToken} = s.options

  const copy = <T,>(value: T): T => { try { return structuredClone(value) } catch { return value } }
  interface Action {label: string; run: () => void; primary?: boolean}

  /** Everything the page shows, re-read from account data on each render. */
  const d = $derived.by(() => {
    void s.renders
    const source = s.current()
    if (!source) return null
    // A fresh copy each render, so in-place account updates still reach the page.
    const order = copy(source)
    const owner = s.owner(), role = s.role(order), done = terminal(order), stops = order.shipment?.stops || []
    const stop = s.ownStop(order)
    const actions: Action[] = []
    const add = (label: string, run: () => void, primary = false) => actions.push({label, run, primary})
    if (role === 'buyer' && ['accepted', 'in-transit'].includes(order.status) && !order.deliveryRequest && !order.deliveryOrderId && order.shipment.stops.length && !order.shipment.stops.some(stop => stop.courierPubkey) && courier) add('Arrange delivery', () => { s.changeView('delivery'); s.render() }, true)
    for (const [id, label] of [[order.deliveryOrderId, 'View delivery'], [order.sourceOrderId, 'View product order']]) { const related = id && s.orders().find(value => value.id === id); if (related) add(label, () => s.showDetail(related)) }
    if (!order.escrowTradeId && role === 'seller' && !done && !order.payment) add('Request payment', () => { s.changeView('payment'); s.render() })
    if (!order.escrowTradeId && role === 'seller' && order.payment?.status === 'requested') add('Confirm payment received', () => s.update(order, {payment: {...order.payment, status: 'received'}}, 'Payment confirmed'))
    if (!order.escrowTradeId && order.status === 'requested' && role === 'seller') add('Accept order', () => s.update(order, {status: 'accepted'}, 'Order accepted'), true)
    if (order.status === 'accepted' && role === 'seller') add('Mark on the way', () => s.update(order, {status: 'in-transit'}, 'Delivery started'), true)
    if (['accepted', 'in-transit'].includes(order.status) && ['seller', 'buyer'].includes(role)) add(role === 'buyer' ? 'Mark received' : 'Mark delivered', () => s.update(order, {status: 'delivered'}, 'Order delivered'), role === 'buyer')
    if (['buyer', 'seller'].includes(role)) add('Message', () => { s.dialog.hide(); void account.openChat(role === 'buyer' ? order.seller : order.buyer, {context: orderContext(order.id)}) })
    if (!done && ['buyer', 'seller'].includes(role)) add(order.status === 'requested' && role === 'seller' ? 'Decline request' : 'Cancel order', () => s.update(order, {status: 'cancelled'}, 'Order cancelled'))
    if (done) add(order.archived ? 'Restore order' : 'Archive order', () => { void s.perform(async () => { await account.messaging.archiveOrder(order.id, !order.archived); s.announce(order.archived ? 'Order restored' : 'Order archived') }) })
    const peer = role === 'buyer' ? order.seller : order.buyer
    const funds = !order.escrowTradeId && onReceiveToken && order.payment?.status !== 'received'
      ? (s.data.conversations?.find(thread => thread.pubkey === peer)?.messages || []).filter(message => !message.mine && message.context?.order_id === order.id && containsCashu(message.text)).slice(-2)
      : []
    return {
      order, source, owner, role, done, stops, actions, funds,
      next: stop ? {stop, progress: transportProgress(order), directions: stopDirections(stop)} : null,
      arrival: orderArrival(order),
      routed: order.status !== 'requested' || !!order.shipment?.stops?.length,
      leg: stop && ['accepted', 'in-transit'].includes(order.status) ? stop : undefined,
      tracking: trackingLink(order.shipment?.trackingUrl),
      reviewPeople: orderReviewParticipants(order, owner),
      version: s.renderVersion,
    }
  })
  // The countdown advances between renders; a missing estimate keeps the last one.
  const headline = $derived.by(() => {
    void s.clock
    const order = s.current()
    return (order && orderArrival(order))?.headline ?? d?.arrival?.headline
  })

  function translation(anchor: HTMLElement, item: {title: string; description?: string}) {
    return insert(anchor, () => translateListingTitle(item, anchor.parentElement!.querySelector(':scope > h3') as HTMLElement))
  }
  function funds(credit: HTMLElement, {message, version, orderId}: {message: {text: string}; version: number; orderId: string}) {
    void renderCashuContent(message.text, {isActive: () => version === s.renderVersion && s.view === 'detail' && s.selected === orderId, onToken: token => onReceiveToken(token, orderId)})
      .then(content => { if (version === s.renderVersion) credit.replaceChildren(content) })
  }
</script>

{#if d}
  {@const order = d.order}
  <div class="order-detail-heading">
    <span class="order-status order-status-{order.status}">{statuses[order.status] || order.status}</span>
    <span class="small muted">{dateTime(order.createdAt)}</span>
  </div>
  {#if d.next}
    {@const stop = d.next.stop}
    <section class="transport-next-stop" aria-label="Next stop">
      <span class="small muted">{stop.status === 'arrived' ? 'At this stop' : 'Next stop'}</span>
      <h3>{stop.label || 'Stop'}</h3>
      {#if stop.address}<p>{stop.address}</p>{/if}
      <p class="small muted">{d.next.progress.completed} of {d.next.progress.total} stops completed</p>
      <div class="order-actions">
        {#if d.next.directions}<a class="button secondary" href={d.next.directions} target="_blank" rel="noopener noreferrer">Directions</a>{/if}
        {@render action(stop.status === 'arrived' ? 'Complete stop' : 'Mark arrived', () => s.update(order, {stopId: stop.id, status: stop.status === 'arrived' ? 'completed' : 'arrived'}, stop.status === 'arrived' ? 'Stop completed' : 'Arrival saved'), true)}
      </div>
    </section>
  {/if}
  {#each order.items || [] as item (item)}
    <div class="order-item">
      <h3>{item.title}</h3>
      <span class="order-item-price">{s.price(item)}{item.quantity > 1 ? ' each' : ''}</span>
      <span hidden use:translation={item}></span>
      {#if item.quantity > 1}<p class="small muted">Quantity {item.quantity}</p>{/if}
    </div>
  {/each}
  {#if d.arrival}
    <section class="order-arrival" aria-label="Estimated arrival">
      <span class="small muted">Estimated arrival</span>
      <strong class="order-arrival-countdown">{headline}</strong>
      <time class="small muted" datetime={new Date(d.arrival.at * 1000).toISOString()}>{dateTime(d.arrival.at)}</time>
    </section>
  {/if}
  {#if d.routed}
    {#key s.renders}<span hidden use:insert={() => s.shipmentMap(order)}></span>{/key}
  {/if}
  <div class="order-participants">
    <Person orders={s} pubkey={order.buyer} label="Buyer" />
    <Person orders={s} pubkey={order.seller} label="Seller" />
  </div>
  {#if order.note}<p class="order-note">{order.note}</p>{/if}
  {#if order.deliveryRequest}
    <section class="order-request-route">
      <h3>Requested route</h3>
      <p>{'Pickup · ' + order.deliveryRequest.pickup.address}</p>
      <p>{'Destination · ' + order.deliveryRequest.destination.address}</p>
    </section>
  {/if}
  {#if order.pickupAuthorization}
    <section class="order-pickup-authorization">
      <h3>Collection</h3>
      <Person orders={s} pubkey={order.pickupAuthorization.courierPubkey} label="Authorized courier" />
      <p class="small muted">{'Pickup reference · ' + order.pickupAuthorization.reference}</p>
    </section>
  {/if}
  {#if order.escrowTradeId}
    {#key s.renders}<span hidden use:insert={() => escrow?.linked(d.source)}></span>{/key}
  {:else if order.payment}
    <section class="order-payment">
      <h3>{order.payment.status === 'received' ? 'Payment received' : 'Payment requested'}</h3>
      <strong>{new Intl.NumberFormat().format(BigInt(order.payment.amount)) + ' ' + mintUnitLabel(order.payment.mint)}</strong>
      <p class="small muted">{new URL(order.payment.mint).hostname + (isTestMint(order.payment.mint) ? ' · Test money · no bitcoin value' : '')}</p>
      {#if order.payment.status === 'received'}<span class="small muted">Confirmed by seller</span>
      {:else if d.role === 'buyer' && onPay && !d.done}{@render action('Pay', () => { void onPay(d.source) }, true)}{/if}
    </section>
  {/if}
  {#key s.renders}
    {#each d.funds as message}<div class="order-funds" use:funds={{message, version: d.version, orderId: order.id}}></div>{/each}
  {/key}
  {#if d.actions.length}
    <div class="order-actions">
      {#each d.actions as item (item.label)}{@render action(item.label, item.run, item.primary)}{/each}
    </div>
  {/if}
  {#if order.sync === 'queued'}<p class="small muted order-sync">Update saved. Waiting to reach the other people in this order.</p>{/if}
  {#if d.routed}
    <section class="order-shipment">
      <h3>Route</h3>
      {#if !d.stops.length}
        <p class="small muted">Delivery or collection details are not set yet.</p>
      {:else}
        <ol class="order-timeline">
          {#each d.stops as stop, index}
            <li class="order-stop order-stop-{stop.status}">
              <span class="order-stop-marker" aria-hidden="true">{stop.status === 'completed' ? '✓' : String(index + 1)}</span>
              <div class="order-stop-content">
                <h4>{stop.label || `Stop ${index + 1}`}</h4>
                {#if stop.address}<p class="small muted">{stop.address}</p>{/if}
                {#if !d.done || stop.status !== 'pending'}<span class="order-stop-state small">{stop.status === 'completed' ? 'Completed' : stop.status === 'arrived' ? 'Arrived' : 'Upcoming'}</span>{/if}
                {#if stop.courierPubkey}<Person orders={s} pubkey={stop.courierPubkey} label="Courier" />{/if}
                {#if !d.done && ['accepted', 'in-transit'].includes(order.status) && (order.seller === d.owner || stop.courierPubkey === d.owner) && stop.status !== 'completed'}
                  <div class="order-stop-actions">
                    {#if stop.status === 'pending'}{@render action('Mark arrived', () => s.update(order, {stopId: stop.id, status: 'arrived'}, 'Arrival saved'))}{/if}
                    {#if stop.status === 'arrived'}{@render action(index === d.stops.length - 1 ? 'Complete delivery' : 'Complete stop', () => s.update(order, {stopId: stop.id, status: 'completed'}, 'Stop completed'))}{/if}
                  </div>
                {/if}
              </div>
            </li>
          {/each}
        </ol>
      {/if}
      {#if d.tracking}<a class="button secondary" href={d.tracking} target="_blank" rel="noopener noreferrer">Track with carrier</a>{/if}
      {#if order.seller === d.owner && !d.done}{@render action(d.stops.length ? 'Edit delivery' : 'Add delivery details', () => { s.changeView('route'); s.render() })}{/if}
      {#if d.leg}
        {@const leg = d.leg}
        {@const on = s.sharing?.orderId === order.id}
        <div class="order-location-control">
          <button type="button" class="button secondary" data-order-action disabled={s.busy} aria-pressed={on} onclick={() => s.toggleLocation(order, leg)}>{on ? 'Stop sharing location' : 'Share live location'}</button>
          <p class="small muted">{s.sharing ? 'Sharing while this order is open.' : 'Shared privately with the people in this order.'}</p>
        </div>
      {/if}
    </section>
  {/if}
  {#if d.reviewPeople.length}
    <section class="order-reviews">
      <h3>Reviews</h3>
      {#each d.reviewPeople as participant}
        <div class="order-review-person">
          <Person orders={s} pubkey={participant.pubkey} label={participant.label} />
          {@render action('Review', () => { s.dialog.hide(); s.onReview(participant.pubkey) })}
        </div>
      {/each}
    </section>
  {/if}
  {#if d.done}<p class="small muted order-archive-note">Archiving only changes your history.</p>{/if}
{/if}

{#snippet action(label: string, run: () => void, primary = false)}
  <button type="button" class="button {primary ? 'primary' : 'secondary'}" data-order-action disabled={s.busy} onclick={run}>{label}</button>
{/snippet}
