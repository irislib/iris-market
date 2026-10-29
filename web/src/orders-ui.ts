import { createSurface } from './surface.ts';
import { createUnreadTracker, orderNotifications, readingSurface } from './notifications.ts';
import type { Shipment, ShipmentStop } from './orders.ts';
import { byId, element as domElement, formFields } from './dom.ts';
import { createUserRow, warmProfiles } from './people.ts';
import { normalizePublicKey } from './social.ts';
import { decode } from 'nostr-tools/nip19';
import { imageUrl } from './media.ts';
import { art } from './art.ts';
import { setupCourierWorkspace, orderReviewParticipants, type CourierFeedOptions } from './courier-ui.ts';

const terminal = order => ['delivered', 'cancelled'].includes(order.status);
const statuses = { requested: 'Requested', accepted: 'Accepted', 'in-transit': 'On the way', delivered: 'Delivered', cancelled: 'Cancelled' };
const node = domElement;
const date = value => Number.isFinite(value) ? new Date(value * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
const dateTime = value => Number.isFinite(value) ? new Date(value * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const localDateTime = value => { if (!Number.isFinite(value)) return ''; const at = new Date(value * 1000); return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const courierKey = (input:string) => {
  try {
    let value = input.trim().replace(/^nostr:/i, '');
    if (/^https?:\/\//i.test(value)) { const url = new URL(value); value = url.searchParams.get('profile') || url.pathname.split('/').filter(Boolean).pop() || ''; }
    if (value.startsWith('nprofile1')) { const profile = decode(value as `nprofile1${string}`); if (profile.type === 'nprofile') value = profile.data.pubkey; }
    return normalizePublicKey(value);
  } catch { throw new Error('Enter a valid public profile link or user ID.'); }
};
const dark = () => document.documentElement.dataset.appearance === 'dark' || (document.documentElement.dataset.appearance !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);

/** Private order requests are separate from chat and never imply a payment. */
export function setupOrders({ account, isPreview = () => false, onProfile = () => {}, onReview = onProfile, courier, onUnread = (_count:number) => {}, page, onNavigate = (_id?:string,_tab?:string) => {}, onClose = () => {}, formatPrice = item => `${item.price || ''} ${item.currency || ''}`.trim() }: {account:ReturnType<typeof import('./account-ui.ts').setupAccount>;isPreview?:()=>boolean;onProfile?:(key:string)=>void;onReview?:(key:string)=>void;courier?:CourierFeedOptions;onUnread?:(count:number)=>void;page?:HTMLElement;onNavigate?:(id?:string,tab?:string)=>void;onClose?:()=>void;formatPrice?:(item:any)=>string}) {
  const unread=createUnreadTracker({kind:'orders',onUnread});
  let state = account.state(), view = 'history', tab = 'purchases', selected, listing, pending, busy = false, error = '', sharing, map, mapLoading, mapHost, mapOrderId, mapGeneration = 0, destroyed = false;
  const dialog = createSurface({className:'orders-dialog',label:'Orders',pageHost:page,onOpen:()=>onNavigate(view==='detail'?selected:undefined,tab),onClose}); dialog.id = 'orders-dialog'; dialog.setAttribute('aria-labelledby', 'orders-title');
  const close = node('button', '×', 'dialog-close icon-button'); close.type = 'button'; close.setAttribute('aria-label', 'Close orders'); close.onclick = () => dialog.close();
  const back = node('button', '← Orders', 'text-button orders-back'); back.type = 'button'; back.onclick = () => showHistory();
  const heading = node('h2', 'Orders'); heading.id = 'orders-title';
  const tabs = node('nav', undefined, 'orders-tabs'); tabs.setAttribute('aria-label', 'Order history');
  const body = node('div', undefined, 'orders-body');
  const failure = node('p', '', 'error orders-error'); failure.setAttribute('role', 'alert');
  const live = node('p', '', 'orders-announcement sr-only'); live.setAttribute('role', 'status');
  dialog.append(close, back, heading, tabs, failure, body, live);
  const orders = () => Array.isArray(state.orders) ? state.orders : [];
  const current = () => orders().find(order => order.id === selected);
  const owner = () => state.ownerPubkey;
  const role = order => order.buyer === owner() ? 'buyer' : order.seller === owner() ? 'seller' : 'courier';
  const ownStop = order => order.shipment?.stops?.find(stop => stop.status !== 'completed' && (order.seller === owner() || stop.courierPubkey === owner()));
  const price = item => { const value = formatPrice(item); return value; };
  const action = (label, fn, primary = false) => { const button = node('button', label, `button ${primary ? 'primary' : 'secondary'}`); button.type = 'button'; button.dataset.orderAction = ''; button.onclick = fn; button.disabled = busy; return button; };
  const person = (pubkey:string, label?:string) => {
    const group = node('div', undefined, 'order-person'); if (label) group.append(node('span', label, 'small muted'));
    if (pubkey) { warmProfiles([pubkey]); group.append(createUserRow(pubkey, { size: 32, onClick: () => { dialog.hide(); onProfile(pubkey); } })); }
    return group;
  };
  const courierUI=courier?setupCourierWorkspace({...courier,getOwner:()=>state.status==='ready'?owner():undefined,getOrders:orders,renderOrder:orderCard,onReviews:key=>{dialog.hide();onReview(key);},onSignIn:()=>{pending={type:'history',section:'deliveries'};account.showAccount();},isPreview}):undefined;
  function syncUnread(){
    const visible=view==='detail'&&readingSurface(dialog);
    unread.update(state.status==='ready'&&!isPreview()?state.ownerPubkey:null,orderNotifications(state.conversations,state.orders||[]),visible?selected:null);
  }
  function setBusy(value) { busy = value; for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-order-action]')) button.disabled = value; }
  async function perform(task) {
    if (busy) return;
    error = ''; failure.textContent = ''; setBusy(true);
    try { await task(); state = account.state(); }
    catch (cause) { error = cause?.message || 'Could not save this update. Try again.'; }
    finally { setBusy(false); if (error && ['review', 'route'].includes(view)) failure.textContent = error; else render(); }
  }
  function dropMap() {
    mapGeneration++; map?.destroy().catch(() => {}); map = mapLoading = mapHost = mapOrderId = undefined;
  }
  function stopLocation({ publish = true } = {}) {
    if (!sharing) return;
    const stopped = sharing; sharing = undefined;
    if (stopped.watch !== undefined) navigator.geolocation?.clearWatch(stopped.watch);
    clearTimeout(stopped.timeout);
    if (publish && state.status === 'ready' && state.ownerPubkey === stopped.owner) void account.messaging.updateOrder(stopped.orderId, { location: null }).catch(() => {});
  }
  function changeView(next) { if(next!=='history')courierUI?.hide();if (next !== 'detail') stopLocation(); view = next; error = ''; if (next !== 'detail') dropMap(); }
  function showHistory() { changeView('history'); selected = undefined; render(); if(dialog.open)onNavigate(undefined,tab); }
  function showDetail(order) {
    if (selected !== order.id) { stopLocation(); dropMap(); }
    selected = order.id; view = 'detail'; error = ''; render(); if(dialog.open)onNavigate(order.id);
  }
  function requestReady(intent) {
    if (isPreview()) { pending = undefined; error = 'Switch to the live market to place an order.'; view = 'history'; render(); if (!dialog.open) dialog.showModal(); return false; }
    if (state.status !== 'ready') { pending = intent; account.showAccount(); return false; }
    return true;
  }
  function open(id,section?:string) { if(['purchases','sales','deliveries','archived'].includes(section))tab=section;state = account.state(); if (!(courierUI&&tab==='deliveries'&&!id) && !requestReady({ type: 'history', id, section })) return; const order = id && orders().find(item => item.id === id); if (order) showDetail(order); else { showHistory(); if (id) { error = 'This order is not available on this device yet.'; render(); } } if (!dialog.open) dialog.showModal(); syncUnread(); }
  function buy(value) {
    state = account.state();
    if (!requestReady({ type: 'buy', listing: value })) return;
    stopLocation(); dropMap(); listing = value; view = 'review'; selected = undefined; error = ''; render(); if (!dialog.open) dialog.showModal();
  }
  function renderTabs() {
    tabs.hidden = view !== 'history'||!!courier&&tab==='deliveries'; tabs.replaceChildren();
    for (const [key, label] of [['purchases', 'Purchases'], ['sales', 'Sales'], ['deliveries', 'Transport'], ['archived', 'Archived']]) {
      const button = node('button', label); button.type = 'button'; button.setAttribute('aria-pressed', String(tab === key));
      button.onclick = () => { tab = key; error = ''; render(); if(dialog.open)onNavigate(undefined,tab); }; tabs.append(button);
    }
  }
  function filteredOrders() {
    return orders().filter(order => tab === 'archived' ? order.archived : !order.archived && (tab === 'purchases' ? order.buyer === owner() : tab === 'sales' ? order.seller === owner() : order.shipment?.stops?.some(stop => stop.courierPubkey === owner() || order.seller === owner())))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  function renderHistory() {
    if(tab==='deliveries'&&courierUI){body.append(courierUI.element);courierUI.show();return;}
    const rows = filteredOrders();
    if (!rows.length) {
      const empty = node('div', undefined, 'orders-empty');
      empty.append(node('h3', tab === 'archived' ? 'Nothing archived' : tab === 'deliveries' ? 'No deliveries yet' : tab === 'sales' ? 'No sales yet' : 'No purchases yet'));
      empty.append(node('p', tab === 'deliveries' ? 'Deliveries you handle appear here.' : tab === 'archived' ? 'Finished orders can be archived without removing their history.' : tab === 'sales' ? 'Order requests for your listings will appear here.' : 'Your orders will appear here.', 'muted'));
      body.append(empty); return;
    }
    const list = node('div', undefined, 'orders-list');
    for (const order of rows) list.append(orderCard(order));
    body.append(list);
  }
  function orderCard(order) {
      const card = node('button', undefined, 'order-card'); card.type = 'button'; card.onclick = () => showDetail(order);
      const text = node('div', undefined, 'order-card-copy'), amount = node('div', undefined, 'order-card-aside');
      const title=node('span', order.items?.map(item => item.title).join(', ') || 'Order', 'order-card-title');
      if(unread.unread(order.id)){const dot=node('span',undefined,'unread-dot');dot.setAttribute('aria-hidden','true');title.append(dot,node('span','Unread update','unread-label'));}
      text.append(title);
      text.append(node('span', `${date(order.createdAt)}${order.items?.[0]?.quantity > 1 ? ` · ${order.items[0].quantity} items` : ''}`, 'small muted'));
      amount.append(node('span', `${price(order.items?.[0] || {})}${order.items?.[0]?.quantity > 1 ? ` × ${order.items[0].quantity}` : ''}`, 'order-card-price'), node('span', statuses[order.status] || order.status, `order-status order-status-${order.status}`));
      card.append(text, amount); return card;
  }
  interface FieldOptions {type?:string;value?:string|number;required?:boolean;maxLength?:number;placeholder?:string;min?:number;max?:number;step?:number|string}
  function input(label:string, options:FieldOptions & {type:'textarea'}):{wrap:HTMLLabelElement;field:HTMLTextAreaElement};
  function input(label:string, options?:FieldOptions):{wrap:HTMLLabelElement;field:HTMLInputElement};
  function input(label:string,{type='text',value='',required=false,maxLength,placeholder,min,max,step}:FieldOptions={}){
    const wrap=node('label',undefined,'order-field'),caption=node('span',label),field=type==='textarea'?node('textarea'):node('input');
    field.value=String(value);field.required=required;if(maxLength)field.maxLength=maxLength;if(placeholder)field.placeholder=placeholder;
    if(field instanceof HTMLInputElement){field.type=type;if(min!==undefined)field.min=String(min);if(max!==undefined)field.max=String(max);if(step!==undefined)field.step=String(step);}
    wrap.append(caption,field);return {wrap,field};
  }
  function renderReview() {
    if (!listing) return;
    const form = node('form', undefined, 'order-review');
    const product = node('div', undefined, 'order-review-item'), image = node('img');
    image.alt = ''; image.referrerPolicy = 'no-referrer'; image.src = imageUrl(listing.imageUrl, { width: 160 }) || art(listing); image.onerror = () => { image.onerror = null; image.src = art(listing); };
    const summary = node('div'); summary.append(node('h3', listing.title), node('p', price(listing), 'order-review-price'));
    product.append(image, summary); form.append(product, person(listing.author, 'Seller'));
    const quantity = input('Quantity', { type: 'number', value: '1', required: true, min: 1, max: 999, step: 1 });
    const note = input('Message to the seller', { type: 'textarea', maxLength: 2000, placeholder: 'Delivery or collection details (optional)' }); note.field.rows = 3;
    form.append(quantity.wrap, note.wrap, node('p', 'The seller will confirm your request. No payment is taken here.', 'small muted'));
    const submit = node('button', 'Request order', 'button primary'); submit.type = 'submit'; submit.dataset.orderAction = ''; submit.disabled = busy || listing.author === owner(); form.append(submit);
    form.onsubmit = event => {
      event.preventDefault(); const count = Number(quantity.field.value), message = note.field.value.trim();
      if (!Number.isInteger(count) || count < 1 || count > 999) { quantity.field.reportValidity(); return; }
      void perform(async () => { const order = await account.messaging.requestOrder(listing, { quantity: count, note: message }); state = account.state(); selected = order.id; view = 'detail'; live.textContent = 'Order requested'; });
    };
    body.append(form);
  }
  function update(order, patch, announcement) { void perform(async () => { await account.messaging.updateOrder(order.id, patch); live.textContent = announcement || 'Order updated'; }); }
  function renderTimeline(order) {
    const stops = order.shipment?.stops || [], section = node('section', undefined, 'order-shipment');
    section.append(node('h3', 'Delivery'));
    if (order.shipment?.eta) section.append(node('p', `Expected ${dateTime(order.shipment.eta)}`, 'order-eta'));
    if (!stops.length) section.append(node('p', 'Delivery or collection details are not set yet.', 'small muted'));
    else {
      const timeline = node('ol', undefined, 'order-timeline');
      for (const [index, stop] of stops.entries()) {
        const row = node('li', undefined, `order-stop order-stop-${stop.status}`), marker = node('span', stop.status === 'completed' ? '✓' : String(index + 1), 'order-stop-marker'); marker.setAttribute('aria-hidden', 'true');
        const content = node('div', undefined, 'order-stop-content'); content.append(node('h4', stop.label || `Stop ${index + 1}`));
        if (stop.address) content.append(node('p', stop.address, 'small muted'));
        if (!terminal(order) || stop.status !== 'pending') content.append(node('span', stop.status === 'completed' ? 'Completed' : stop.status === 'arrived' ? 'Arrived' : 'Upcoming', 'order-stop-state small'));
        if (stop.courierPubkey) content.append(person(stop.courierPubkey, 'Courier'));
        if (!terminal(order) && ['accepted', 'in-transit'].includes(order.status) && (order.seller === owner() || stop.courierPubkey === owner()) && stop.status !== 'completed') {
          const actions = node('div', undefined, 'order-stop-actions');
          if (stop.status === 'pending') actions.append(action('Mark arrived', () => update(order, { stopId: stop.id, status: 'arrived' }, 'Arrival saved')));
          if (stop.status === 'arrived') actions.append(action(index === stops.length - 1 ? 'Complete delivery' : 'Complete stop', () => update(order, { stopId: stop.id, status: 'completed' }, 'Stop completed')));
          content.append(actions);
        }
        row.append(marker, content); timeline.append(row);
      }
      section.append(timeline);
    }
    const tracking = order.shipment?.trackingUrl;
    if (tracking) { try { const url = new URL(tracking); if (url.protocol === 'https:' && !url.username && !url.password) { const link = node('a', 'Track with carrier', 'button secondary'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; section.append(link); } } catch {} }
    if (order.seller === owner() && !terminal(order)) section.append(action(stops.length ? 'Edit delivery' : 'Add delivery details', () => { changeView('route'); render(); }));
    const leg = ownStop(order);
    if (leg && ['accepted', 'in-transit'].includes(order.status)) {
      const location = node('div', undefined, 'order-location-control');
      const toggle=action(sharing?.orderId === order.id ? 'Stop sharing location' : 'Share live location', () => { if (sharing) { stopLocation(); render(); } else startLocation(order, leg); });toggle.setAttribute('aria-pressed',String(sharing?.orderId===order.id));location.append(toggle);
      location.append(node('p', sharing ? 'Sharing while this order is open.' : 'Shared privately with the people in this order.', 'small muted')); section.append(location);
    }
    return section;
  }
  function shipmentMap(order) {
    const shipment = order.shipment || {}, hasLocation = shipment.stops?.some(stop => stop.coordinates) || shipment.location?.coordinates;
    if (!hasLocation) return null;
    if (!mapHost || mapOrderId !== order.id) {
      dropMap(); mapOrderId = order.id; mapHost = node('div', undefined, 'order-map-section');
      const canvas = node('div', undefined, 'order-map'); canvas.setAttribute('aria-label', 'Delivery map');
      const status = node('p', '', 'small muted'); status.setAttribute('role', 'status');
      mapHost.append(canvas, node('p', 'Stops joined directly; not driving directions.', 'small muted'), status);
      const generation = mapGeneration;
      mapLoading = import('./map/shipment.ts').then(({ setupShipmentMap }) => setupShipmentMap(canvas, { dark: dark(), onError: cause => { if (generation === mapGeneration) status.textContent = cause.message || 'Map unavailable'; } })).then(async instance => {
        if (destroyed || generation !== mapGeneration || !dialog.open || view !== 'detail') { await instance.destroy(); return; }
        map = instance; map.setShipment(current()?.shipment || shipment); map.resize();
      }).catch(() => { if (generation === mapGeneration) status.textContent = 'Map unavailable. See the delivery details below.'; });
    } else if (map) map.setShipment(shipment);
    return mapHost;
  }
  function renderDetail() {
    const order = current(); if (!order) { showHistory(); return; }
    const selfRole = role(order), summary = node('div', undefined, 'order-detail-heading');
    summary.append(node('span', statuses[order.status] || order.status, `order-status order-status-${order.status}`), node('span', dateTime(order.createdAt), 'small muted'));
    body.append(summary);
    for (const item of order.items || []) {
      const itemRow = node('div', undefined, 'order-item'); itemRow.append(node('h3', item.title), node('span', `${price(item)}${item.quantity > 1 ? ' each' : ''}`, 'order-item-price'));
      if (item.quantity > 1) itemRow.append(node('p', `Quantity ${item.quantity}`, 'small muted')); body.append(itemRow);
    }
    if (order.status !== 'requested' || order.shipment?.stops?.length) { const mapNode = shipmentMap(order); if (mapNode) body.append(mapNode); }
    const participants = node('div', undefined, 'order-participants'); participants.append(person(order.buyer, 'Buyer'), person(order.seller, 'Seller')); body.append(participants);
    if (order.note) body.append(node('p', order.note, 'order-note'));
    const actions = node('div', undefined, 'order-actions');
    if (order.status === 'requested' && selfRole === 'seller') actions.append(action('Accept order', () => update(order, { status: 'accepted' }, 'Order accepted'), true));
    if (order.status === 'accepted' && selfRole === 'seller') actions.append(action('Mark on the way', () => update(order, { status: 'in-transit' }, 'Delivery started'), true));
    if (['accepted', 'in-transit'].includes(order.status) && ['seller', 'buyer'].includes(selfRole)) actions.append(action(selfRole === 'buyer' ? 'Mark received' : 'Mark delivered', () => update(order, { status: 'delivered' }, 'Order delivered'), selfRole === 'buyer'));
    if (['buyer', 'seller'].includes(selfRole)) actions.append(action('Message', () => { dialog.hide(); void account.openChat(selfRole === 'buyer' ? order.seller : order.buyer); }));
    if (!terminal(order) && ['buyer', 'seller'].includes(selfRole)) actions.append(action(order.status === 'requested' && selfRole === 'seller' ? 'Decline request' : 'Cancel order', () => update(order, { status: 'cancelled' }, 'Order cancelled')));
    if (terminal(order)) actions.append(action(order.archived ? 'Restore order' : 'Archive order', () => { void perform(async () => { await account.messaging.archiveOrder(order.id, !order.archived); live.textContent = order.archived ? 'Order restored' : 'Order archived'; }); }));
    body.append(actions);
    if (order.sync === 'queued') body.append(node('p', 'Update saved. Waiting to reach the other people in this order.', 'small muted order-sync'));
    if (order.status !== 'requested' || order.shipment?.stops?.length) body.append(renderTimeline(order));
    const reviewPeople=orderReviewParticipants(order,owner());
    if(reviewPeople.length){
      const section=node('section',undefined,'order-reviews');section.append(node('h3','Reviews'));
      for(const participant of reviewPeople){const row=node('div',undefined,'order-review-person');row.append(person(participant.pubkey,participant.label),action('Review',()=>{dialog.hide();onReview(participant.pubkey);}));section.append(row);}
      body.append(section);
    }
    if (terminal(order)) body.append(node('p', 'Archiving only changes your history.', 'small muted order-archive-note'));
  }
  function renderRoute() {
    const order = current(); if (!order || order.seller !== owner() || terminal(order)) { view = 'detail'; renderDetail(); return; }
    const form = node('form', undefined, 'order-route-form'), fields = node('div', undefined, 'order-route-stops'), rows = [];
    function addStop(value:Partial<ShipmentStop> = {}) {
      if (rows.length >= 12) return;
      const row = node('fieldset', undefined, 'order-route-stop'), legend = node('legend', `Stop ${rows.length + 1}`);
      const label = input('Label', { value: value.label || '', maxLength: 80, required: true, placeholder: 'Pickup, depot, destination…' });
      const address = input('Address', { value: value.address || '', maxLength: 500, placeholder: 'Street, city or meeting point' });
      const courier = input('Courier profile', { value: '', placeholder: 'Paste a profile link or user ID (optional)' });
      let assigned = value.courierPubkey;
      const assignment = node('div', undefined, 'order-route-assignee');
      if (assigned) { assignment.append(person(assigned)); const remove = node('button', 'Remove courier', 'text-button'); remove.type = 'button'; remove.onclick = () => { assigned = undefined; assignment.replaceChildren(); }; assignment.append(remove); }
      const coordinates = node('details', undefined, 'order-coordinate-fields'); coordinates.append(node('summary', 'Map position'));
      const pair = node('div', undefined, 'order-field-pair'), latitude = input('Latitude', { type: 'number', value: value.coordinates?.[1] ?? '', min: -90, max: 90, step: 'any' }), longitude = input('Longitude', { type: 'number', value: value.coordinates?.[0] ?? '', min: -180, max: 180, step: 'any' });
      pair.append(latitude.wrap, longitude.wrap); coordinates.append(pair);
      const remove = node('button', 'Remove stop', 'text-button'); remove.type = 'button'; remove.onclick = () => { rows.splice(rows.indexOf(record), 1); row.remove(); rows.forEach((item, index) => { item.legend.textContent = `Stop ${index + 1}`; }); add.disabled = rows.length >= 12; };
      const record = { row, legend, read() {
        const lat = latitude.field.value.trim(), lon = longitude.field.value.trim();
        if (!!lat !== !!lon) throw new Error('Enter both latitude and longitude for a map position.');
        const result:ShipmentStop = { id: value.id || crypto.randomUUID(), label: label.field.value.trim(), address: address.field.value.trim(), status: value.status || 'pending' };
        if (lat && lon) { const coordinates = [Number(lon), Number(lat)]; if (!coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) throw new Error('Check the map coordinates.'); result.coordinates = coordinates as [number,number]; }
        const profile = courier.field.value.trim(); if (profile) result.courierPubkey = courierKey(profile); else if (assigned) result.courierPubkey = assigned;
        return result;
      } };
      rows.push(record); row.append(legend, label.wrap, address.wrap, assignment, courier.wrap, coordinates, remove); fields.append(row);
    }
    const add = action('Add stop', () => { addStop(); add.disabled = rows.length >= 12; });
    for (const stop of order.shipment?.stops?.length ? order.shipment.stops : [{ label: 'Pickup' }, { label: 'Destination' }]) addStop(stop);
    add.disabled = rows.length >= 12;
    const eta = input('Expected arrival', { type: 'datetime-local', value: localDateTime(order.shipment?.eta) });
    const tracking = input('Carrier tracking link', { type: 'url', value: order.shipment?.trackingUrl || '', placeholder: 'https://…' });
    const actions = node('div', undefined, 'order-actions'), save = node('button', 'Save delivery', 'button primary'); save.type = 'submit'; save.dataset.orderAction = ''; actions.append(save, action('Cancel', () => { view = 'detail'; error = ''; render(); }));
    form.append(fields, add, eta.wrap, tracking.wrap, actions);
    form.onsubmit = event => { event.preventDefault(); void perform(async () => {
      const shipment:Shipment = { stops: rows.map(row => row.read()) };
      if (tracking.field.value.trim()) { const url = new URL(tracking.field.value.trim()); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a secure tracking link.'); shipment.trackingUrl = url.href; }
      if (eta.field.value) { const at = Date.parse(eta.field.value); if (!Number.isFinite(at)) throw new Error('Check the expected arrival time.'); shipment.eta = Math.floor(at / 1000); }
      await account.messaging.updateOrder(order.id, { shipment }); view = 'detail'; live.textContent = 'Delivery saved';
    }); };
    body.append(form);
  }
  function startLocation(order, stop) {
    if (!navigator.geolocation) { error = 'Location sharing is unavailable in this browser.'; render(); return; }
    stopLocation();
    const session = { orderId: order.id, stopId: stop.id, owner: owner(), lastAt: 0, sending: false, watch: undefined, timeout: undefined }; sharing = session;
    const failed = cause => { if (sharing !== session) return; stopLocation(); error = cause?.code === 1 ? 'Location permission was not granted.' : 'Could not get your location. Try again.'; render(); };
    try {
      session.watch = navigator.geolocation.watchPosition(position => {
        if (sharing !== session || document.visibilityState === 'hidden' || !dialog.open || view !== 'detail' || selected !== session.orderId) return;
        const at = Date.now(); if (session.sending || at - session.lastAt < 15000) return;
        const coordinates = [position.coords.longitude, position.coords.latitude].map(value => Math.round(value * 100000) / 100000);
        if (!coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) return;
        session.lastAt = at; session.sending = true;
        void account.messaging.updateOrder(order.id, { location: { coordinates:coordinates as [number,number], stopId: stop.id } }).catch(cause => { if (sharing === session) { stopLocation(); error = cause.message || 'Could not share location.'; render(); } }).finally(() => { session.sending = false; });
      }, failed, { enableHighAccuracy: false, maximumAge: 10000, timeout: 15000 });
      session.timeout = setTimeout(() => { if (sharing === session) { stopLocation(); render(); } }, 60 * 60 * 1000);
      error = ''; render();
    } catch (cause) { failed(cause); }
  }
  function render() {
    if (destroyed) return;
    syncUnread();
    if(view!=='history'||tab!=='deliveries')courierUI?.hide();
    heading.textContent = view === 'review' ? 'Request an order' : view === 'route' ? 'Delivery details' : view === 'detail' ? 'Order details' : tab==='deliveries'?'Transport':'Orders';
    back.hidden = view === 'history'; failure.textContent = error; renderTabs();
    const scrollTop = dialog.scrollTop; body.replaceChildren();
    if (view === 'review') renderReview(); else if (view === 'detail') renderDetail(); else if (view === 'route') renderRoute(); else renderHistory();
    dialog.scrollTop = scrollTop;
  }
  function refresh(value = account.state()) {
    const previousOwner = state.ownerPubkey; state = value;
    if (previousOwner && (previousOwner !== state.ownerPubkey || state.status !== 'ready')) { stopLocation({ publish: false }); dropMap(); if (dialog.open) dialog.close(); }
    courierUI?.refresh();
    syncUnread();
    const order = current();
    const sharedStop = sharing && order?.shipment?.stops?.find(stop => stop.id === sharing.stopId && stop.status !== 'completed' && (order.seller === owner() || stop.courierPubkey === owner()));
    if (sharing && (!order || terminal(order) || !sharedStop || order.archived || document.visibilityState === 'hidden')) stopLocation();
    if (pending && state.status === 'ready') { const intent = pending; pending = undefined; account.closeAccount?.(); if (intent.type === 'buy') buy(intent.listing); else open(intent.id,intent.section); return; }
    // Preserve typing while private updates arrive in the background.
    if (dialog.open && !['review', 'route'].includes(view)) render();
  }
  dialog.addEventListener('close', () => { courierUI?.hide();stopLocation(); dropMap(); syncUnread(); });
  const hidden = () => { syncUnread(); if (document.visibilityState === 'hidden') { stopLocation(); if (dialog.open && view === 'detail') render(); } };
  const focused=()=>{syncUnread();if(dialog.open&&view==='history')render();};
  const uncovered=()=>queueMicrotask(focused);
  const theme = () => { map?.setDark(dark()).catch(() => {}); };
  document.addEventListener('visibilitychange', hidden);document.addEventListener('close',uncovered,true); window.addEventListener('focus',focused); window.addEventListener('market-themechange', theme);
  const appearance = matchMedia('(prefers-color-scheme: dark)'); appearance.addEventListener('change', theme);
  const unsubscribe=account.onState?.(refresh);syncUnread();
  window.addEventListener('pagehide', () => { stopLocation(); dropMap(); courierUI?.destroy();destroyed = true;unsubscribe?.();window.removeEventListener('focus',focused);document.removeEventListener('visibilitychange', hidden);document.removeEventListener('close',uncovered,true); window.removeEventListener('market-themechange', theme); appearance.removeEventListener('change', theme); });
  return { open, buy, refresh, refreshCourier(){if(dialog.open&&view==='history'&&tab==='deliveries')courierUI?.refresh();}, hide:()=>dialog.hide() };
}
