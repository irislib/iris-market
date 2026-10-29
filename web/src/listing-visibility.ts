/** Local browsing preferences; never published or used to delete a listing. */
const LIMIT = 1000;
type Store = Pick<Storage, 'getItem' | 'setItem'>;
export function createHiddenListings(storage: Store, key: string) {
  let ids = new Set<string>();
  try { const value = JSON.parse(storage.getItem(key) || '[]'); if (Array.isArray(value)) ids = new Set(value.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 512).slice(0, LIMIT)); } catch {}
  function save(next: Set<string>) { storage.setItem(key, JSON.stringify([...next])); ids = next; }
  return {
    has: (id: string) => ids.has(id), count: () => ids.size,
    hide(id: string) { if (!id || id.length > 512) throw new Error('Invalid listing.'); if (!ids.has(id) && ids.size >= LIMIT) throw new Error('Restore hidden listings in Settings before hiding more.'); save(new Set([...ids, id])); },
    show(id: string) { const next = new Set(ids); next.delete(id); save(next); },
    clear() { save(new Set()); },
  };
}

export interface PhotoFilterContext {
  saved: boolean; map: boolean; query: string; side: string; category: string;
  location: string; shipsTo: string; tags: readonly string[]; authors: readonly string[] | null; network: boolean;
}
/** A deliberate checkbox choice wins; the automatic default applies only to the entry feed. */
export function wantsPhotos(choice: boolean | null, context: PhotoFilterContext): boolean {
  if (choice !== null) return choice;
  return !context.saved && !context.map && !context.query.trim() && context.side === 'offer' && context.category === 'all' &&
    !context.location && !context.shipsTo && !context.tags.length && context.authors === null && !context.network;
}

/** Native details elements keep this tiny menu keyboard accessible without per-card global listeners. */
export function installListingMenus(root: Document = document) {
  const close = (except?: Element, focus = false) => root.querySelectorAll<HTMLDetailsElement>('details.listing-menu[open]').forEach(menu => {
    if (except && menu.contains(except)) return;
    menu.open = false; if (focus) menu.querySelector('summary')?.focus();
  });
  const pointer = (event: Event) => close(event.target instanceof Element ? event.target : undefined);
  const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') close(undefined, true); };
  root.addEventListener('pointerdown', pointer); root.addEventListener('focusin', pointer); root.addEventListener('keydown', keyboard);
  return () => { root.removeEventListener('pointerdown', pointer); root.removeEventListener('focusin', pointer); root.removeEventListener('keydown', keyboard); };
}

export function listingMenu(title: string, hidden: boolean, onSelect: () => void) {
  const menu = document.createElement('details'); menu.className = 'listing-menu';
  const trigger = document.createElement('summary'); trigger.setAttribute('aria-label', `Options for ${title}`);
  trigger.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
  const panel = document.createElement('div'); panel.className = 'listing-menu-panel';
  const button = document.createElement('button'); button.type = 'button'; button.textContent = hidden ? 'Show listing' : 'Hide listing';
  button.onclick = () => { menu.open = false; onSelect(); }; panel.append(button); menu.append(trigger, panel); return menu;
}
