import { element as node } from '../dom.ts';
import { nextTransportStop, transportProgress } from '../transport-job.ts';
import { date, statuses } from './format.ts';

/** An order row. Built as a plain element because the courier workspace also lists it. */
export function createOrderCard(order, {owner, deliveries, unread, price, onOpen}:{owner?:string;deliveries:boolean;unread:boolean;price:(item:any)=>string;onOpen:()=>void}):HTMLElement {
  const card = node('button', undefined, 'order-card'); card.type = 'button'; card.onclick = onOpen;
  const text = node('div', undefined, 'order-card-copy'), amount = node('div', undefined, 'order-card-aside');
  const title = node('span', order.items?.map(item => item.title).join(', ') || 'Order', 'order-card-title');
  if (unread) { const dot = node('span', undefined, 'unread-dot'); dot.setAttribute('aria-hidden', 'true'); title.append(dot, node('span', 'Unread update', 'unread-label')); }
  text.append(title);
  if (deliveries) {
    const stop = nextTransportStop(order, owner), progress = transportProgress(order);
    if (stop) text.append(node('span', `${stop.status === 'arrived' ? 'At' : 'Next'}: ${stop.label || 'Stop'}${stop.address ? ` · ${stop.address}` : ''}`, 'order-next-label'));
    if (progress.total) text.append(node('span', `${progress.completed} of ${progress.total} stops completed`, 'small muted'));
  }
  text.append(node('span', `${date(order.createdAt)}${order.items?.[0]?.quantity > 1 ? ` · ${order.items[0].quantity} items` : ''}`, 'small muted'));
  amount.append(node('span', `${price(order.items?.[0] || {})}${order.items?.[0]?.quantity > 1 ? ` × ${order.items[0].quantity}` : ''}`, 'order-card-price'), node('span', statuses[order.status] || order.status, `order-status order-status-${order.status}`));
  card.append(text, amount); return card;
}
