/**
 * Insert whatever an existing DOM helper builds in place of a hidden anchor, keeping
 * it a direct child of the parent. Unlike svelte/place.ts, the helper may return
 * nothing, or a fragment whose children are all placed. Wrap in {#key} to rebuild.
 */
export function insert(anchor: HTMLElement, make: () => Node | null | undefined) {
  const made = make()
  const nodes = !made ? [] : made instanceof DocumentFragment ? [...made.childNodes] : [made]
  anchor.before(...nodes)
  return {destroy() { for (const node of nodes) node.parentNode?.removeChild(node) }}
}

/** Collect what a helper appends to a host it is given, for `insert`. */
export function collect(fill: (host: HTMLElement) => void): DocumentFragment {
  const host = document.createElement('div'), fragment = document.createDocumentFragment()
  fill(host)
  fragment.append(...host.childNodes)
  return fragment
}
