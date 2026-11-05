/** A pending message waits in CSS; results and errors remove the delay immediately. */
export function setLoadingStatus(node: HTMLElement, message: string, pending = false) {
  if (pending) {
    // A new request gets a full delay even when this node is reused mid-load.
    node.dataset.loadingStatus = 'ready';
    node.getAnimations?.();
  }
  node.dataset.loadingStatus = pending ? 'pending' : 'ready';
  node.textContent = message;
}
