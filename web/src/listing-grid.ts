import {spaceSellers} from './seller-spacing.ts';

/** A bounded window which keeps already-browsed cards in place as live data arrives. */
export class ListingWindow {
  pageSize:number; key:string|null; limit:number; ids:string[]; pinned:boolean; pinnedCount:number;
  constructor(pageSize = 24) { this.pageSize = pageSize; this.reset(); }
  reset() { this.key = null; this.limit = this.pageSize; this.ids = []; this.pinned = false; this.pinnedCount = 0; }
  pin(count = this.ids.length) { this.pinned = true; this.pinnedCount = Math.max(this.pinnedCount,count); }
  more(count = this.ids.length) { this.pin(count); this.limit += this.pageSize; }
  update<T extends {id:string;author?:string}>(items:T[], key:string, mixSellers=false) {
    if (this.key !== key) { this.reset(); this.key = key; }
    const byId = new Map(items.map(item => [item.id, item]));
    const pinned = this.pinned ? this.ids.slice(0, mixSellers ? this.pinnedCount : this.ids.length) : [];
    const shown:T[] = [];
    for (const id of pinned) {
      if (byId.has(id)) { shown.push(byId.get(id)); byId.delete(id); }
    }
    this.pinnedCount = shown.length;
    const available = this.limit - shown.length;
    const rest = [...byId.values()];
    const next = shown.concat(mixSellers ? spaceSellers(rest,shown,available) : rest.slice(0,available));
    this.ids = next.map(item => item.id);
    return next;
  }
}

export function setupListingGrid({grid, controls, button, status, makeCard, cardKey, olderState, loadOlder}) {
  const windowed = new ListingWindow();
  let items = [], viewKey, rendered = new Map(), automatic = 0, loading = false, loadGeneration = 0, disposed = false, visible = true, scrolled = false, mixSellers = false;
  // Once scrolling starts, keep cards the reader has reached in their places.
  function browsedCount() {
    if (!mixSellers) return windowed.ids.length;
    const below = Array.from(grid.children as HTMLCollectionOf<HTMLElement>).findIndex(card => card.getBoundingClientRect().top >= window.innerHeight);
    return below < 0 ? grid.children.length : below;
  }
  const pagination = () => olderState?.() || {hasMore:false};
  let ownsEmptyState = false;
  function paint() {
    if (disposed) return;
    const shown = windowed.update(items, viewKey, mixSellers), next = new Map();
    // Remove missing cards before positioning their neighbors.
    const shownIds = new Set(shown.map(item => item.id));
    for (const [id, entry] of rendered) if (!shownIds.has(id)) {
      entry.node.remove(); rendered.delete(id);
    }
    for (const [index, item] of shown.entries()) {
      const key = cardKey(item), previous = rendered.get(item.id);
      const entry = previous?.key === key ? previous : {key, node:makeCard(item)};
      entry.node.dataset.listingId = item.id;
      if (grid.children[index] !== entry.node) grid.insertBefore(entry.node, grid.children[index] || null);
      next.set(item.id, entry);
    }
    for (const [id, entry] of rendered) if (next.get(id).node !== entry.node) entry.node.remove();
    rendered = next;
    const remote = pagination(), localMore = shown.length < items.length;
    const hasMore = localMore || remote.hasMore;
    controls.hidden = !visible || !hasMore && !loading && !remote.loading && !remote.error && !shown.length;
    button.hidden = !hasMore && !remote.error;
    button.disabled = loading || Boolean(remote.loading);
    ownsEmptyState = !shown.length && Boolean(remote.loading || remote.error || remote.hasMore && remote.emptyMore);
    const emptyFailure = Boolean(remote.error) && !shown.length && !loading && !remote.loading;
    button.textContent = loading || remote.loading ? 'Loading…' : emptyFailure ? 'Try again' : 'Load more';
    status.textContent = shown.length ? `${shown.length} ${shown.length===1?'listing':'listings'} shown` : emptyFailure ? remote.emptyError || 'Could not load listings.' : (loading || remote.loading) ? remote.emptyPending || '' : remote.hasMore ? remote.emptyMore || '' : '';
    grid.setAttribute('aria-busy', String(loading || Boolean(remote.loading)));
    // Two automatic batches, then explicit loading keeps the footer reachable.
    observer?.unobserve(controls);
    if (scrolled && visible && hasMore && automatic < 2 && !loading && !remote.loading && !remote.error && !remote.paused && shown.length) observer?.observe(controls);
  }
  async function more(manual = false) {
    if (disposed || loading || !visible) return;
    // Once the reader chooses Load more, every further batch stays explicit.
    if (manual) automatic = 2; else automatic++;
    const count = browsedCount();
    if (windowed.ids.length < items.length) { windowed.more(count); paint(); return; }
    if (!pagination().hasMore && !pagination().error) return;
    // Reserve space now: verified rows and AI matches arrive before the request ends.
    const current = ++loadGeneration;
    windowed.more(count); loading = true; paint();
    try { await loadOlder(); }
    finally { if (current === loadGeneration) { loading = false; paint(); } }
  }
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    if (scrolled && entries.some(entry => entry.isIntersecting) && automatic < 2 && !document.querySelector('dialog[open]')) void more();
  }, {rootMargin:'500px 0px'}) : null;
  const pinOnScroll = () => {
    if (window.scrollY > 100) {
      windowed.pin(browsedCount());
      if (!scrolled) { scrolled = true; paint(); }
    }
  };
  window.addEventListener('scroll', pinOnScroll, {passive:true});
  button.onclick = () => void more(true);
  return {
    update(next, key, mix=false) {
      if (viewKey !== key) { loadGeneration++; loading = false; automatic = 0; scrolled = false; windowed.reset(); }
      if (mix && scrolled && visible) windowed.pin(browsedCount());
      items=next;viewKey=key;mixSellers=mix;paint();
    },
    ownsEmptyState: () => ownsEmptyState,
    pin() { windowed.pin(browsedCount()); },
    setVisible(value) { visible = value; paint(); },
    reset() {loadGeneration++; loading = false; automatic = 0; scrolled = false; windowed.reset(); },
    dispose() { disposed = true; loadGeneration++; observer?.disconnect(); window.removeEventListener('scroll', pinOnScroll); },
  };
}
