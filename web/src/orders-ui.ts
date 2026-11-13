import { flushSync, mount } from 'svelte';
import Dialog from './orders-view/Dialog.svelte';
import { OrdersState, type OrdersOptions } from './orders-view/state.svelte.ts';

/** Private order requests are separate from chat and never imply a payment. */
export function setupOrders(options: OrdersOptions) {
  const orders = new OrdersState(options);
  mount(Dialog, {target: orders.dialog, props: {orders}});
  flushSync();
  window.addEventListener('pagehide', () => orders.destroy());
  return {
    open: (id?:string, section?:string) => orders.open(id, section),
    buy: value => orders.buy(value),
    refresh: (value?) => orders.refresh(value),
    refreshCourier: () => orders.refreshCourier(),
    hide: () => orders.dialog.hide(),
  };
}
