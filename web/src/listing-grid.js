/** A bounded window which keeps already-browsed cards in place as live data arrives. */
export class ListingWindow {
  constructor(pageSize = 24) { this.pageSize = pageSize; this.reset(); }
  reset() { this.key = null; this.limit = this.pageSize; this.ids = []; this.pinned = false; }
  pin() { this.pinned = true; }
  more() { this.pin(); this.limit += this.pageSize; }
  update(items, key) {
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
  let items = [], viewKey, rendered = new Map(), automatic = 0, loading = false, disposed = false, visible = true, scrolled = false;
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
    button.disabled = loading || remote.loading;
    button.textContent = loading || remote.loading ? 'Loading…' : remote.error && !localMore ? 'Try again' : 'Load more';
    status.textContent = remote.error && !localMore ? 'Could not load more listings.' : shown.length ? `${shown.length} of ${items.length} listings` : '';
    grid.setAttribute('aria-busy', String(loading || Boolean(remote.loading)));
    // Re-observe after the page grows. At most three automatic batches keep the footer reachable.
    observer?.unobserve(controls);
    if (scrolled && visible && hasMore && automatic < 3 && !loading && !remote.loading && !remote.error && shown.length) observer?.observe(controls);
  }
  async function more(manual = false) {
    if (disposed || loading || !visible) return;
    if (manual) automatic = 0; else automatic++;
    windowed.pin();
    if (windowed.ids.length < items.length) { windowed.more(); paint(); return; }
    if (!pagination().hasMore && !pagination().error) return;
    loading = true; paint();
    const requestedKey = viewKey;
    try { await loadOlder(); if (requestedKey === viewKey) windowed.more(); }
    finally { loading = false; paint(); }
  }
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    if (scrolled && entries.some(entry => entry.isIntersecting) && automatic < 3 && !document.querySelector('dialog[open]')) void more();
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
    update(next, key) { if (viewKey !== key) { automatic = 0; scrolled = false; windowed.reset(); } items = next; viewKey = key; paint(); },
    pin() { windowed.pin(); },
    setVisible(value) { visible = value; paint(); },
    reset() { automatic = 0; scrolled = false; windowed.reset(); },
    dispose() { disposed = true; observer?.disconnect(); window.removeEventListener('scroll', pinOnScroll); },
  };
}
