/**
 * Insert a node built by existing DOM helpers in place of a hidden anchor, so it
 * stays a direct child of its parent for grid/flex layout. Wrap in {#key} to rebuild.
 */
export function place(anchor: HTMLElement, make: () => Node) {
  const node = make()
  anchor.before(node)
  return {destroy() { node.parentNode?.removeChild(node) }}
}
