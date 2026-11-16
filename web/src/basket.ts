import {MAX_ITEMS, type OrderListing} from './orders.ts';

/** A listing as kept in the basket: enough to show it and to request it later, even offline. */
export interface BasketItem {listing: OrderListing; quantity: number; addedAt: number}
export interface BasketGroup {seller: string; items: BasketItem[]}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

const key = (owner: string) => `market-basket-v1/${owner || 'guest'}`;
const keep = ({id, eventId, author, title, price, currency, side, status, expiration, imageUrl}: OrderListing & {imageUrl?: string}): OrderListing =>
  ({id, eventId, author, title, price, currency, side, status, expiration, imageUrl});

/**
 * A local, per-profile basket grouped by seller: each group becomes one order request.
 * Nothing here is published; the basket lives only in this browser.
 */
export function createBasket(storage: Storage | undefined = globalThis.localStorage, owner = () => '') {
  const read = (): BasketItem[] => {
    try { const value = JSON.parse(storage?.getItem(key(owner())) ?? '[]'); return Array.isArray(value) ? value.filter(item => item?.listing?.id && item.listing.author && Number.isInteger(item.quantity) && item.quantity >= 1) : []; }
    catch { return []; }
  };
  const write = (items: BasketItem[]) => { try { if (items.length) storage?.setItem(key(owner()), JSON.stringify(items)); else storage?.removeItem(key(owner())); } catch { /* A full or blocked store leaves the basket as it was. */ } };
  return {
    items: read,
    count: () => read().reduce((sum, item) => sum + item.quantity, 0),
    groups(): BasketGroup[] {
      const groups = new Map<string, BasketItem[]>();
      for (const item of read()) groups.set(item.listing.author, [...(groups.get(item.listing.author) ?? []), item]);
      return [...groups].map(([seller, items]) => ({seller, items}));
    },
    /** Adds a listing, or one more of it; returns false when that seller's group is full. */
    add(listing: OrderListing, quantity = 1) {
      const items = read(), existing = items.find(item => item.listing.id === listing.id);
      if (existing) existing.quantity = Math.min(999, existing.quantity + quantity);
      else {
        if (items.filter(item => item.listing.author === listing.author).length >= MAX_ITEMS) return false;
        items.push({listing: keep(listing), quantity, addedAt: Date.now()});
      }
      write(items); return true;
    },
    setQuantity(id: string, quantity: number) { write(read().flatMap(item => item.listing.id !== id ? [item] : quantity >= 1 ? [{...item, quantity: Math.min(999, Math.floor(quantity))}] : [])); },
    remove(id: string) { write(read().filter(item => item.listing.id !== id)); },
    clearSeller(seller: string) { write(read().filter(item => item.listing.author !== seller)); },
  };
}
export type Basket = ReturnType<typeof createBasket>;
