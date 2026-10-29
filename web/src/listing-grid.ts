/** A bounded window which keeps already-browsed cards in place as live data arrives. */
export class ListingWindow {
  pageSize:number; key:string|null; limit:number; ids:string[]; pinned:boolean;
  constructor(pageSize = 24) { this.pageSize = pageSize; this.reset(); }
  reset() { this.key = null; this.limit = this.pageSize; this.ids = []; this.pinned = false; }
  pin() { this.pinned = true; }
  more() { this.pin(); this.limit += this.pageSize; }
  update<T extends {id:string}>(items:T[], key:string) {
    if (this.key !== key) { this.reset(); this.key = key; }
    const byId = new Map(items.map(item => [item.id, item]));
    const retained = this.pinned ? this.ids.filter(id => byId.has(id)) : [];
    const retainedSet = new Set(retained);
    const order = [...retained, ...byId.keys()].filter((id, index) => index < retained.length || !retainedSet.has(id));
    this.ids = order.slice(0, this.limit);
    return this.ids.map(id => byId.get(id));
  }
}

export function setupListingGrid({grid, controls, button, status, makeCard, cardKey, olderState, loadOlder}) {
  const windowed = new ListingWindow();
  let items = [], viewKey, rendered = new Map(), automatic = 0, loading = false, loadGeneration = 0, disposed = false, visible = true, scrolled = false;
  const pagination = () => olderState?.() || {hasMore:false};
  function paint() {
    if (disposed) return;
    const shown = windowed.update(items, viewKey), next = new Map();
    for (const [index, item] of shown.entries()) {
      const key = cardKey(item), previous = rendered.get(item.id);
      const entry = previous?.key === key ? previous : {key, node:makeCard(item)};
      entry.node.dataset.listingId = item.id;
      if (grid.children[index] !== entry.node) grid.insertBefore(entry.node, grid.children[index] || null);
      next.set(item.id, entry);
    }
    for (const [id, entry] of rendered) if (!next.has(id) || next.get(id).node !== entry.node) entry.node.remove();
    rendered = next;
    const remote = pagination(), localMore = shown.length < items.length;
    const hasMore = localMore || remote.hasMore;
    controls.hidden = !visible || !hasMore && !loading && !remote.error && !shown.length;
    button.hidden = !hasMore && !remote.error;
    button.disabled = loading || Boolean(remote.loading);
    const emptyFailure = Boolean(remote.error) && !shown.length;
    button.textContent = loading || remote.loading ? 'Loading…' : emptyFailure ? 'Try again' : 'Load more';
    status.textContent = shown.length ? `${shown.length} ${shown.length===1?'listing':'listings'} shown` : emptyFailure ? 'Could not load listings.' : '';
    grid.setAttribute('aria-busy', String(loading || Boolean(remote.loading)));
    // Two automatic batches, then explicit loading keeps the footer reachable.
    observer?.unobserve(controls);
    if (scrolled && visible && hasMore && automatic < 2 && !loading && !remote.loading && !remote.error && !remote.paused && shown.length) observer?.observe(controls);
  }
  async function more(manual = false) {
    if (disposed || loading || !visible) return;
    // Once the reader chooses Load more, every further batch stays explicit.
    if (manual) automatic = 2; else automatic++;
    windowed.pin();
    if (windowed.ids.length < items.length) { windowed.more(); paint(); return; }
    if (!pagination().hasMore && !pagination().error) return;
    // Reserve space now: verified rows and AI matches arrive before the request ends.
    const current = ++loadGeneration;
    windowed.more(); loading = true; paint();
    try { await loadOlder(); }
    finally { if (current === loadGeneration) { loading = false; paint(); } }
  }
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    if (scrolled && entries.some(entry => entry.isIntersecting) && automatic < 2 && !document.querySelector('dialog[open]')) void more();
  }, {rootMargin:'500px 0px'}) : null;
  const pinOnScroll = () => {
    if (window.scrollY > 100) {
      windowed.pin();
      if (!scrolled) { scrolled = true; paint(); }
    }
  };
  window.addEventListener('scroll', pinOnScroll, {passive:true});
  button.onclick = () => void more(true);
  return {
    update(next, key) { if (viewKey !== key) { loadGeneration++; loading = false; automatic = 0; scrolled = false; windowed.reset(); } items = next; viewKey = key; paint(); },
    pin() { windowed.pin(); },
    setVisible(value) { visible = value; paint(); },
    reset() { loadGeneration++; loading = false; automatic = 0; scrolled = false; windowed.reset(); },
    dispose() { disposed = true; loadGeneration++; observer?.disconnect(); window.removeEventListener('scroll', pinOnScroll); },
  };
}
