import {flushSync, mount, unmount} from 'svelte'
import {element} from './dom.ts'
import {productReviewTarget} from './product-reviews.ts'
import ProductPanel from './reviews/ProductPanel.svelte'
import {ProductReviews, type ProductReviewOptions} from './reviews/product.svelte.ts'

/** Read-only product recommendations. Seller/profile ratings have a separate projection. */
export function setupProductReviews(options: ProductReviewOptions) {
  const {listing, preview = false} = options
  const target = productReviewTarget(/^(?:30402|38383):/.test(listing.id) ? listing.id : `30402:${listing.id}`)
  if (listing.author && target.split(':')[1] !== listing.author) throw new Error('Product author does not match its address.')
  const panel = element('section', undefined, 'profile-reviews product-reviews')
  const state = new ProductReviews(target, options)
  const view = mount(ProductPanel, {target: panel, props: {reviews: state}})
  flushSync()
  if (preview) panel.hidden = true
  // Callers read the panel as soon as a lookup settles.
  const settled = (pending: Promise<void>) => pending.then(() => { if (!state.closed) flushSync() })
  return {
    element: panel,
    start: () => settled(state.start()),
    refresh: () => settled(state.read()),
    destroy() { state.destroy(); void unmount(view) },
  }
}
