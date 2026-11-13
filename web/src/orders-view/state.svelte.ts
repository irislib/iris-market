import { flushSync } from 'svelte';
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
}

type View = 'history'|'detail'|'review'|'route'|'delivery'|'payment';
interface Sharing {orderId:string;stopId:string;owner:string;lastAt:number;sending:boolean;watch?:number;timeout?:ReturnType<typeof setTimeout>}
const formViews = ['route', 'delivery', 'payment'];

/** Order history, the open order and its forms. Account data lives outside Svelte; `renders` re-reads it. */
export class OrdersState {
  view = $state<View>('history');
  tab = $state('purchases');
  selected = $state<string|undefined>();
  listing = $state.raw<any>();
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
  onProfile:(key:string)=>void;
  onReview:(key:string)=>void;
  onNavigate:(id?:string,tab?:string)=>void;
  dialog:Surface;
  unread:ReturnType<typeof createUnreadTracker>;
  courierUI:ReturnType<typeof setupCourierWorkspace>|undefined;
  data:any;
  pending:any;
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
    this.escrow = options.escrow;
    this.courier = options.courier;
    this.isPreview = options.isPreview ?? (() => false);
    this.onProfile = options.onProfile ?? (() => {});
    this.onReview = options.onReview ?? this.onProfile;
    this.onNavigate = options.onNavigate ?? ((_id?:string,_tab?:string) => {});
    this.formatPrice = options.formatPrice ?? (item => `${item.price || ''} ${item.currency || ''}`.trim());
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
    return createOrderCard(order, {owner:this.owner(), deliveries:this.tab === 'deliveries', unread:!!this.unread.unread(order.id), price:item => this.price(item), onOpen:() => this.showDetail(order)});
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
  showHistory() { this.changeView('history'); this.selected = undefined; this.render(); if (this.dialog.open) this.onNavigate(undefined, this.tab); }
  showDetail(order) {
    this.clearEditors();
    if (this.selected !== order.id) { this.stopLocation(); this.dropMap(); }
    this.selected = order.id; this.view = 'detail'; this.error = ''; this.render(); if (this.dialog.open) this.onNavigate(order.id);
  }
  showTab(key:string) { this.tab = key; this.error = ''; this.render(); if (this.dialog.open) this.onNavigate(undefined, this.tab); }
  requestReady(intent) {
    if (this.isPreview()) { this.pending = undefined; this.error = 'Switch to the live market to place an order.'; this.view = 'history'; this.render(); if (!this.dialog.open) this.dialog.showModal(); return false; }
    if (this.data.status !== 'ready') { this.pending = intent; this.account.showAccount(); return false; }
    return true;
  }
  open(id?:string, section?:string) {
    if (['purchases', 'sales', 'deliveries', 'archived', 'escrow'].includes(section)) this.tab = section;
    this.data = this.account.state();
    if (!(this.courierUI && this.tab === 'deliveries' && !id) && !this.requestReady({ type: 'history', id, section })) return;
    const order = id && this.orders().find(item => item.id === id);
    if (order) this.showDetail(order); else { this.showHistory(); if (id) { this.error = 'This order is not available on this device yet.'; this.render(); } }
    if (!this.dialog.open) this.dialog.showModal();
    this.syncUnread();
  }
  buy(value) {
    this.data = this.account.state();
    if (!this.requestReady({ type: 'buy', listing: value })) return;
    this.stopLocation(); this.dropMap(); this.listing = value; this.view = 'review'; this.selected = undefined; this.error = ''; this.render(); if (!this.dialog.open) this.dialog.showModal();
  }
  /** The tabs shown; also falls back from Escrow jobs once they are unavailable. */
  sections():[string,string][] {
    const sections:[string,string][] = [['purchases', 'Purchases'], ['sales', 'Sales'], ['deliveries', 'Transport']];
    if (this.escrow?.showJobs()) sections.push(['escrow', 'Escrow jobs']);
    sections.push(['archived', 'Archived']);
    return sections;
  }
  filteredOrders() {
    const owner = this.owner(), tab = this.tab;
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
    if (this.view === 'delivery' && this.current() && this.courier) this.editors = [createDeliveryPlaceInput({label:'Destination'})];
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
    if (this.pending && this.data.status === 'ready') { const intent = this.pending; this.pending = undefined; this.account.closeAccount?.(); if (intent.type === 'buy') this.buy(intent.listing); else this.open(intent.id, intent.section); return; }
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
