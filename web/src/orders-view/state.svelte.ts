import { flushSync } from 'svelte';
import type {Basket, BasketItem} from '../basket.ts';
import {filterOrders, ordersCsv, type OrderPeriod, type OrderStatusFilter} from './summary.ts';
import {nameFor} from '../people.ts';
import { createSurface, type Surface } from '../surface.ts';
import { createUnreadTracker, orderNotifications, readingSurface } from '../notifications.ts';
import { element as node } from '../dom.ts';
import { setupCourierWorkspace, type CourierFeedOptions } from '../courier-ui.ts';
import { nextTransportStop } from '../transport-job.ts';
import { createDeliveryPlaceInput } from '../delivery-place-ui.ts';
import type { OrderView } from '../orders.ts';
import { orderArrival } from '../order-arrival.ts';
import { createOrderCard } from './card.ts';
import { dark, terminal } from './format.ts';

export interface OrdersOptions {
  escrow?:ReturnType<typeof import('../escrow-trade-ui.ts').setupEscrowTrade>;
  onPay?:(order:OrderView)=>unknown;
  onReceiveToken?:(token:string,orderId:string)=>unknown;
  account:ReturnType<typeof import('../account-ui.ts').setupAccount>;
  isPreview?:()=>boolean;
  onProfile?:(key:string)=>void;
  onReview?:(key:string)=>void;
  courier?:CourierFeedOptions;
  onUnread?:(count:number)=>void;
  page?:HTMLElement;
  onNavigate?:(id?:string,tab?:string)=>void;
  onClose?:()=>void;
  formatPrice?:(item:any)=>string;
  /** The order total in whole sats, when the listing price can be converted. */
  satsFor?:(item:any)=>number|null;
  /** This browser's basket, grouped by seller; each group becomes one order. */
  basket?:Basket;
  /** The photo of a listing this device knows, for orders made before photos were recorded. */
  imageFor?:(item:any)=>string|undefined;
}

type View = 'history'|'detail'|'review'|'route'|'delivery'|'payment';
interface Sharing {orderId:string;stopId:string;owner:string;lastAt:number;sending:boolean;watch?:number;timeout?:ReturnType<typeof setTimeout>}
const formViews = ['route', 'delivery', 'payment'];

/** Order history, the open order and its forms. Account data lives outside Svelte; `renders` re-reads it. */
export class OrdersState {
  view = $state<View>('history');
  tab = $state('purchases');
  period = $state<OrderPeriod>('all');
  statusFilter = $state<OrderStatusFilter>('all');
  selected = $state<string|undefined>();
  listing = $state.raw<any>();
  basketSelection = $state.raw<{items: BasketItem[]; owner: string}>();
  withEscrow = false;
  ownCarrier = false;
  busy = $state(false);
  error = $state('');
  announcement = $state('');
  sharing = $state.raw<Sharing|undefined>();
  /** Bumped whenever the original page would have been rebuilt. */
  renders = $state(0);
  /** Bumped when the delivery service list should be re-read. */
  providers = $state(0);
  /** Bumped when tool settings (escrow) change under an open order form. */
  tools = $state(0);
  /** Bumped by the arrival countdown timer. */
  clock = $state(0);

  options:OrdersOptions;
  account:OrdersOptions['account'];
  escrow:OrdersOptions['escrow'];
  courier:CourierFeedOptions|undefined;
  isPreview:()=>boolean;
  formatPrice:(item:any)=>string;
  satsFor:(item:any)=>number|null;
  basket:Basket|undefined;
  basketVersion = $state(0);
  imageFor:(item:any)=>string|undefined;
  onProfile:(key:string)=>void;
  onReview:(key:string)=>void;
  onNavigate:(id?:string,tab?:string)=>void;
  dialog:Surface;
  unread:ReturnType<typeof createUnreadTracker>;
  courierUI:ReturnType<typeof setupCourierWorkspace>|undefined;
  data:any;
  pending:any;
  restoring = true;
  /** True while Orders was opened without a tab and the reader has not picked one. */
  autoTab = false;
  map:any;
  mapLoading:Promise<unknown>|undefined;
  mapHost:HTMLElement|undefined;
  mapOrderId:string|undefined;
  mapGeneration = 0;
  destroyed = false;
  /** Guards async renderers (Cashu tokens) against stale pages. */
  renderVersion = 0;
  /** Place editors for the form being rendered; they mount their own components, so are built before a flush. */
  editors:ReturnType<typeof createDeliveryPlaceInput>[] = [];
  #cleanup:(()=>void)[] = [];

  constructor(options:OrdersOptions) {
    const {account, page, onClose = () => {}, onUnread = (_count:number) => {}} = options;
    this.options = options;
    this.account = account;
    // Until the saved profile has been restored, a signed-out state is not yet an answer.
    void Promise.resolve((account as {restored?:Promise<unknown>}).restored).finally(() => { this.restoring = false; if (this.pending && this.account.state().status !== 'ready') this.account.showAccount(); });
    this.escrow = options.escrow;
    this.courier = options.courier;
    this.isPreview = options.isPreview ?? (() => false);
    this.onProfile = options.onProfile ?? (() => {});
    this.onReview = options.onReview ?? this.onProfile;
    this.onNavigate = options.onNavigate ?? ((_id?:string,_tab?:string) => {});
    this.formatPrice = options.formatPrice ?? (item => `${item.price || ''} ${item.currency || ''}`.trim());
    this.imageFor = options.imageFor ?? (() => undefined);
    this.basket = options.basket;
    this.satsFor = options.satsFor ?? (item => ['SATS', 'TESTSAT'].includes(String(item?.currency).toUpperCase()) && Number(item.price) > 0 ? Math.ceil(Number(item.price) * (item.quantity || 1)) : null);
    this.unread = createUnreadTracker({kind:'orders', onUnread});
    this.data = account.state();
    this.dialog = createSurface({className:'orders-dialog', label:'Orders', pageHost:page, onOpen:() => this.onNavigate(this.view === 'detail' ? this.selected : undefined, this.tab), onClose});
    this.dialog.id = 'orders-dialog'; this.dialog.setAttribute('aria-labelledby', 'orders-title');
    const courier = this.courier;
    this.courierUI = courier ? setupCourierWorkspace({...courier, getOwner:() => this.data.status === 'ready' ? this.owner() : undefined, getOrders:() => this.orders(), renderOrder:order => this.card(order),
      onReviews:key => { this.dialog.hide(); this.onReview(key); }, onSignIn:() => { this.pending = {type:'history', section:'deliveries'}; account.showAccount(); }, isPreview:this.isPreview}) : undefined;
    this.#listen();
  }

  orders():OrderView[] { return Array.isArray(this.data.orders) ? this.data.orders : []; }
  current():OrderView|undefined { return this.orders().find(order => order.id === this.selected); }
  owner():string { return this.data.ownerPubkey; }
  role(order) { return order.buyer === this.owner() ? 'buyer' : order.seller === this.owner() ? 'seller' : 'courier'; }
  ownStop(order) { return nextTransportStop(order, this.owner()); }
  price(item) { return this.formatPrice(item); }
  announce(text:string) { this.announcement = text; }

  card(order):HTMLElement {
    return createOrderCard(order, {owner:this.owner(), deliveries:this.tab === 'deliveries', unread:!!this.unread.unread(order.id), price:item => this.price(item), onOpen:() => this.showDetail(order), image:order.items?.[0]?.image ?? this.imageFor(order.items?.[0])});
  }
  openProfile(pubkey:string) { this.dialog.hide(); this.onProfile(pubkey); }
  clearEditors() { for (const editor of this.editors) editor.destroy(); this.editors = []; }

  syncUnread() {
    const visible = this.view === 'detail' && readingSurface(this.dialog);
    this.unread.update(this.data.status === 'ready' && !this.isPreview() ? this.data.ownerPubkey : null, orderNotifications(this.data.conversations, this.data.orders || []), visible ? this.selected : null);
  }
  async perform(task:() => unknown) {
    if (this.busy) return;
    this.error = ''; this.busy = true;
    try { await task(); this.data = this.account.state(); }
    catch (cause) { this.error = cause?.message || 'Could not save this update. Try again.'; }
    finally { this.busy = false; if (!(this.view === 'review' || (this.error && formViews.includes(this.view)))) this.render(); }
  }
  update(order, patch, announcement?:string) { void this.perform(async () => { await this.account.messaging.updateOrder(order.id, patch); this.announce(announcement || 'Order updated'); }); }
  dropMap() {
    this.mapGeneration++; this.map?.destroy().catch(() => {}); this.map = this.mapLoading = this.mapHost = this.mapOrderId = undefined;
  }
  stopLocation({ publish = true } = {}) {
    if (!this.sharing) return;
    const stopped = this.sharing; this.sharing = undefined;
    if (stopped.watch !== undefined) navigator.geolocation?.clearWatch(stopped.watch);
    clearTimeout(stopped.timeout);
    if (publish && this.data.status === 'ready' && this.data.ownerPubkey === stopped.owner) void this.account.messaging.updateOrder(stopped.orderId, { location: null }).catch(() => {});
  }
  changeView(next:View) { this.clearEditors(); if (next !== 'history') this.courierUI?.hide(); if (next !== 'detail') this.stopLocation(); this.view = next; this.error = ''; if (next !== 'detail') this.dropMap(); }
  openRoute(ownCarrier = false) { this.changeView('route'); this.ownCarrier = ownCarrier; this.render(); }
  showHistory() { this.changeView('history'); this.selected = undefined; this.render(); if (this.dialog.open) this.onNavigate(undefined, this.tab); }
  showDetail(order) {
    this.clearEditors();
    if (this.selected !== order.id) { this.stopLocation(); this.dropMap(); }
    this.selected = order.id; this.view = 'detail'; this.error = ''; this.render(); if (this.dialog.open) this.onNavigate(order.id);
  }
  showTab(key:string) { this.autoTab = false; this.tab = key; this.error = ''; this.render(); if (this.dialog.open) this.onNavigate(undefined, this.tab); }
  requestReady(intent) {
    if (this.isPreview()) { this.pending = undefined; this.error = 'Switch to the live market to place an order.'; this.view = 'history'; this.render(); if (!this.dialog.open) this.dialog.showModal(); return false; }
    if (this.data.status !== 'ready') { this.pending = intent; if (!this.restoring) this.account.showAccount(); return false; }
    return true;
  }
  open(id?:string, section?:string) {
    if (['purchases', 'sales', 'deliveries', 'archived', 'escrow'].includes(section)) this.tab = section;
    this.autoTab = !section && !id;
    this.data = this.account.state();
    // Opening Orders from its badge shows the unread order rather than an empty tab.
    if (!section && !id && !this.tabUnread(this.tab)) this.tab = ['purchases', 'sales', ...(this.escrow?.showJobs() ? ['escrow'] : [])].find(tab => this.tabUnread(tab)) ?? (['purchases', 'sales'].includes(this.tab) ? this.tab : 'purchases');
    const guestBasket = !this.isPreview() && !id && this.tab === 'purchases' && this.data.status === 'signed-out' && this.basket?.count();
    if (!guestBasket && !(this.courierUI && this.tab === 'deliveries' && !id) && !this.requestReady({ type: 'history', id, section })) return;
    const order = id && this.orders().find(item => item.id === id);
    if (order) this.showDetail(order); else { this.showHistory(); if (id) { this.error = 'This order is not available on this device yet.'; this.render(); } }
    if (!this.dialog.open) this.dialog.showModal();
    this.syncUnread();
  }
  buy(value, basketSelection?: {items: BasketItem[]; owner: string}, withEscrow = false) {
    this.data = this.account.state();
    if (!this.requestReady({ type: 'buy', listing: value, basketSelection, withEscrow })) return;
    this.basketSelection = basketSelection; this.withEscrow = withEscrow;
    this.stopLocation(); this.dropMap(); this.listing = value; this.view = 'review'; this.selected = undefined; this.error = ''; this.render(); if (!this.dialog.open) this.dialog.showModal();
  }
  /** The tabs shown; also falls back from Escrow jobs once they are unavailable. */
  sections():[string,string][] {
    if (this.data.status === 'signed-out') return [];
    const sections:[string,string][] = [['purchases', 'Purchases'], ['sales', 'Sales'], ['deliveries', 'Transport']];
    if (this.escrow?.showJobs()) sections.push(['escrow', 'Escrow jobs']);
    sections.push(['archived', 'Archived']);
    return sections;
  }
  /** Opens the order review for one seller's basket group. */
  checkoutBasket(seller: string) {
    const group = this.basket?.groups().find(value => value.seller === seller); if (!group?.items.length) return
    this.buy(group.items[0].listing, {items: group.items, owner: this.owner() || ''})
  }
  basketChanged() { this.basketVersion++ }
  /** True when an order on this tab has an update the reader has not opened. */
  tabUnread(tab:string) { return tab === 'escrow' ? (this.escrow?.attention?.() ?? 0) > 0 : ['purchases', 'sales'].includes(tab) && this.filteredOrders(tab).some(order => !!this.unread.unread(order.id)) }
  /** The current tab after the history filters; unread dots and tab choice ignore these filters. */
  visibleOrders() { return ['purchases', 'sales', 'archived'].includes(this.tab) ? filterOrders(this.filteredOrders(), {period: this.period, status: this.statusFilter}) : this.filteredOrders() }
  exportCsv() {
    const csv = ordersCsv(this.visibleOrders(), this.owner() ?? '', nameFor)
    const link = document.createElement('a'), url = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}))
    link.href = url; link.download = `iris-market-${this.tab}-${new Date().toISOString().slice(0, 10)}.csv`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  filteredOrders(tab = this.tab) {
    const owner = this.owner();
    return this.orders().filter(order => tab === 'archived' ? order.archived : !order.archived && (tab === 'purchases' ? order.buyer === owner : tab === 'sales' ? order.seller === owner : order.shipment?.stops?.some(stop => stop.courierPubkey === owner || order.seller === owner)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  shipmentMap(order):HTMLElement|null {
    const shipment = order.shipment || {}, hasLocation = shipment.stops?.some(stop => stop.coordinates) || shipment.location?.coordinates;
    if (!hasLocation) return null;
    if (!this.mapHost || this.mapOrderId !== order.id) {
      this.dropMap(); this.mapOrderId = order.id; const host = this.mapHost = node('div', undefined, 'order-map-section');
      const canvas = node('div', undefined, 'order-map'); canvas.setAttribute('aria-label', 'Route map');
      const status = node('p', '', 'small muted'); status.setAttribute('role', 'status');
      host.append(canvas, node('p', 'Stops joined directly; not driving directions.', 'small muted'), status);
      const generation = this.mapGeneration;
      this.mapLoading = import('../map/shipment.ts').then(({ setupShipmentMap }) => setupShipmentMap(canvas, { dark: dark(), onError: cause => { if (generation === this.mapGeneration) status.textContent = cause.message || 'Map unavailable'; } })).then(async instance => {
        if (this.destroyed || generation !== this.mapGeneration || !this.dialog.open || this.view !== 'detail') { await instance.destroy(); return; }
        this.map = instance; this.map.setShipment(this.current()?.shipment || shipment); this.map.resize();
      }).catch(() => { if (generation === this.mapGeneration) status.textContent = 'Map unavailable. See the delivery details below.'; });
    } else if (this.map) this.map.setShipment(shipment);
    return this.mapHost;
  }
  startLocation(order, stop) {
    if (!navigator.geolocation) { this.error = 'Location sharing is unavailable in this browser.'; this.render(); return; }
    this.stopLocation();
    const session:Sharing = { orderId: order.id, stopId: stop.id, owner: this.owner(), lastAt: 0, sending: false, watch: undefined, timeout: undefined }; this.sharing = session;
    const failed = cause => { if (this.sharing !== session) return; this.stopLocation(); this.error = cause?.code === 1 ? 'Location permission was not granted.' : 'Could not get your location. Try again.'; this.render(); };
    try {
      session.watch = navigator.geolocation.watchPosition(position => {
        if (this.sharing !== session || document.visibilityState === 'hidden' || !this.dialog.open || this.view !== 'detail' || this.selected !== session.orderId) return;
        const at = Date.now(); if (session.sending || at - session.lastAt < 15000) return;
        const coordinates = [position.coords.longitude, position.coords.latitude].map(value => Math.round(value * 100000) / 100000);
        if (!coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) return;
        session.lastAt = at; session.sending = true;
        void this.account.messaging.updateOrder(order.id, { location: { coordinates:coordinates as [number,number], stopId: stop.id } }).catch(cause => { if (this.sharing === session) { this.stopLocation(); this.error = cause.message || 'Could not share location.'; this.render(); } }).finally(() => { session.sending = false; });
      }, failed, { enableHighAccuracy: false, maximumAge: 10000, timeout: 15000 });
      session.timeout = setTimeout(() => { if (this.sharing === session) { this.stopLocation(); this.render(); } }, 60 * 60 * 1000);
      this.error = ''; this.render();
    } catch (cause) { failed(cause); }
  }
  toggleLocation(order, leg) { if (this.sharing) { this.stopLocation(); this.render(); } else this.startLocation(order, leg); }
  /** Rebuild the page from account data, keeping the scroll position. */
  render() {
    if (this.destroyed) return;
    this.syncUnread();
    if (this.view !== 'history' || this.tab !== 'deliveries') this.courierUI?.hide();
    if (!this.escrow?.showJobs() && this.tab === 'escrow') this.tab = 'purchases';
    if (this.view === 'route') { const order = this.current(); if (!order || order.seller !== this.owner() || terminal(order)) this.view = 'detail'; }
    if (this.view === 'detail' && !this.current()) { this.showHistory(); return; }
    const scrollTop = this.dialog.scrollTop;
    this.renderVersion++; this.clearEditors();
    if (this.view === 'review' && this.listing?.category === 'transport') this.editors = [createDeliveryPlaceInput({label:'Pickup'}), createDeliveryPlaceInput({label:'Destination'})];
    if (this.view === 'delivery' && this.current() && this.courier) {
      const order = this.current(), stops = order.shipment.stops;
      const place = (label:string, stop?:OrderView['shipment']['stops'][number]) => createDeliveryPlaceInput({label, ...(stop?.address ? {value:{label, address:stop.address, coordinates:stop.coordinates}} : {})});
      this.editors = [...(order.seller === this.owner() ? [place('Pickup', stops[0])] : []), place('Destination', stops.length > 1 ? stops.at(-1) : undefined)];
    }
    this.renders++;
    flushSync();
    this.dialog.scrollTop = scrollTop;
  }
  refresh(value = this.account.state()) {
    const previousOwner = this.data.ownerPubkey; this.data = value;
    if (previousOwner && (previousOwner !== this.data.ownerPubkey || this.data.status !== 'ready')) { this.stopLocation({ publish: false }); this.dropMap(); if (this.dialog.open) this.dialog.close(); }
    this.courierUI?.refresh();
    this.syncUnread();
    const order = this.current(), sharing = this.sharing;
    const sharedStop = sharing && order?.shipment?.stops?.find(stop => stop.id === sharing.stopId && stop.status !== 'completed' && (order.seller === this.owner() || stop.courierPubkey === this.owner()));
    if (sharing && (!order || terminal(order) || !sharedStop || order.archived || document.visibilityState === 'hidden')) this.stopLocation();
    if (this.pending && this.data.status === 'ready') { const intent = this.pending; this.pending = undefined; this.account.closeAccount?.(); if (intent.type === 'buy') this.buy(intent.listing, intent.basketSelection, intent.withEscrow); else this.open(intent.id, intent.section); return; }
    // Orders that arrive after opening move an empty, unpicked tab to the one with news.
    if (this.autoTab && this.dialog.open && this.view === 'history' && !this.filteredOrders(this.tab).length) { const next = ['purchases', 'sales'].find(tab => this.tabUnread(tab)); if (next) this.tab = next; }
    // Preserve typing while private updates arrive in the background.
    if (this.dialog.open && !['review', 'route', 'delivery', 'payment'].includes(this.view)) this.render();
  }
  refreshCourier() {
    if (this.dialog.open && this.view === 'delivery') { this.providers++; flushSync(); return; }
    if (this.dialog.open && this.view === 'history' && this.tab === 'deliveries') this.courierUI?.refresh();
  }
  refreshArrival() {
    if (this.destroyed || !this.dialog.open || this.view !== 'detail' || document.visibilityState === 'hidden') return;
    const order = this.current();
    if (order && orderArrival(order)) { this.clock++; flushSync(); }
  }
  #listen() {
    const {dialog} = this;
    dialog.addEventListener('close', () => { this.clearEditors(); this.renderVersion++; this.courierUI?.hide(); this.stopLocation(); this.dropMap(); this.syncUnread(); });
    const arrivalTimer = setInterval(() => this.refreshArrival(), 15000);
    const hidden = () => { this.syncUnread(); if (document.visibilityState === 'hidden') { this.stopLocation(); if (dialog.open && this.view === 'detail') this.render(); } else this.refreshArrival(); };
    const focused = () => { this.syncUnread(); this.refreshArrival(); if (dialog.open && this.view === 'history') this.render(); };
    const uncovered = () => queueMicrotask(focused);
    const theme = () => { this.map?.setDark(dark()).catch(() => {}); };
    const appearance = matchMedia('(prefers-color-scheme: dark)');
    const settingsChanged = () => { if (!dialog.open) return; if (this.view === 'review') { this.tools++; flushSync(); } else if (this.view === 'history' || this.view === 'detail') this.render(); };
    document.addEventListener('visibilitychange', hidden); document.addEventListener('close', uncovered, true); window.addEventListener('focus', focused); window.addEventListener('market-themechange', theme);
    appearance.addEventListener('change', theme);
    window.addEventListener('market-tools-change', settingsChanged);
    const unsubscribe = this.account.onState?.(value => this.refresh(value)); this.syncUnread();
    this.#cleanup.push(() => { window.removeEventListener('market-tools-change', settingsChanged); clearInterval(arrivalTimer); this.stopLocation(); this.dropMap(); this.courierUI?.destroy(); this.destroyed = true; unsubscribe?.(); window.removeEventListener('focus', focused); document.removeEventListener('visibilitychange', hidden); document.removeEventListener('close', uncovered, true); window.removeEventListener('market-themechange', theme); appearance.removeEventListener('change', theme); });
  }
  destroy() { for (const stop of this.#cleanup.splice(0)) stop(); }
}
