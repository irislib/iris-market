import {npubEncode} from 'nostr-tools/nip19';

/** Order fields the history filters, totals and export read. */
export interface SummaryOrder {
  id: string; buyer: string; seller: string; status: string; createdAt: number; archived?: boolean
  items: Array<{id: string; title: string; price: string; currency: string; quantity: number; eventId?: string}>
}
export type OrderPeriod = 'all' | '30d' | 'year' | 'last-year';
export type OrderStatusFilter = 'all' | 'open' | 'delivered' | 'cancelled';
export const ORDER_PERIODS: ReadonlyArray<[OrderPeriod, string]> = [['all', 'All time'], ['30d', 'Last 30 days'], ['year', 'This year'], ['last-year', 'Last year']];
export const ORDER_STATUS_FILTERS: ReadonlyArray<[OrderStatusFilter, string]> = [['all', 'Any status'], ['open', 'Open'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']];

const DAY = 86400;
function inPeriod(createdAt: number, period: OrderPeriod, now: number) {
  if (period === 'all') return true;
  if (period === '30d') return createdAt >= now - 30 * DAY;
  const year = new Date(now * 1000).getFullYear() - (period === 'last-year' ? 1 : 0);
  return new Date(createdAt * 1000).getFullYear() === year;
}
function hasStatus(status: string, filter: OrderStatusFilter) {
  return filter === 'all' || (filter === 'open' ? !['delivered', 'cancelled'].includes(status) : status === filter);
}
export function filterOrders<T extends SummaryOrder>(orders: T[], {period = 'all', status = 'all', now = Math.floor(Date.now() / 1000)}: {period?: OrderPeriod; status?: OrderStatusFilter; now?: number} = {}): T[] {
  return orders.filter(order => inPeriod(order.createdAt, period, now) && hasStatus(order.status, status));
}

/** Totals per currency in each listing's own currency; cancelled orders and negotiable prices are left out. */
export function orderTotals(orders: SummaryOrder[]) {
  const totals = new Map<string, number>();
  for (const order of orders) {
    if (order.status === 'cancelled') continue;
    for (const item of order.items) {
      const price = Number(item.price);
      if (item.price === '' || !Number.isFinite(price)) continue;
      totals.set(item.currency, (totals.get(item.currency) ?? 0) + price * item.quantity);
    }
  }
  return [...totals].map(([currency, amount]) => ({currency, amount})).sort((a, b) => a.currency.localeCompare(b.currency));
}

type PricedItem = {price: string | number; currency: string; quantity: number};
/** One line's price: the unit price times its count when the price is a number. */
export function linePrice<T extends PricedItem>(item: T, price: (item: T) => string): string {
  const unit = Number(item.price);
  return item.quantity > 1 && item.price !== '' && Number.isFinite(unit) ? price({...item, price: String(unit * item.quantity)}) : price(item);
}

/** The order total when every item shares a currency; otherwise the first item with a count. */
export function orderPrice<T extends PricedItem>(order: {items?: T[]}, price: (item: T) => string): string {
  const items = order.items || [], first = items[0] ?? ({price: '', currency: '', quantity: 1} as T);
  if (items.length > 1 && items.every(item => item.currency === first.currency && item.price !== '' && Number.isFinite(Number(item.price)))) return price({...first, price: String(items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0))});
  return `${price(first)}${first.quantity > 1 ? ` × ${first.quantity}` : ''}${items.length > 1 ? ` + ${items.length - 1} more` : ''}`;
}

const cell = (value: unknown) => { const text = String(value ?? ''); return /[",\n\r]/.test(text) || /^[=+\-@\t]/.test(text) ? `"${(/^[=+\-@\t]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"` : text; };
/** A spreadsheet-safe CSV of the orders shown, one row per item. Formula-like text is quoted so it stays text. */
export function ordersCsv(orders: SummaryOrder[], owner: string, nameFor: (pubkey: string) => string = () => '') {
  const rows: unknown[][] = [['Date', 'Order', 'Type', 'Item', 'Quantity', 'Unit price', 'Currency', 'Total', 'Status', 'Other person', 'Other person ID', 'Listing', 'Listing revision']];
  for (const order of orders) {
    const sale = order.seller === owner, other = sale ? order.buyer : order.seller;
    for (const item of order.items) {
      const price = Number(item.price), total = item.price !== '' && Number.isFinite(price) ? String(price * item.quantity) : '';
      let otherId = other; try { otherId = npubEncode(other); } catch {}
      rows.push([new Date(order.createdAt * 1000).toISOString().slice(0, 10), order.id, sale ? 'Sale' : 'Purchase', item.title, item.quantity, item.price, item.currency, total, order.status, nameFor(other), otherId, item.id, item.eventId ?? '']);
    }
  }
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
