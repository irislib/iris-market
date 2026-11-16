import {flushSync} from 'svelte'
import {buildProductReviewDraft, loadProductReviews, parseProductReview, productReviewsFromEvents} from '../product-reviews.ts'
import type {ProductReview} from '../product-reviews.ts'
import type {ReviewQuery} from '../reviews.ts'

export interface ProductReviewOptions {
  listing: {id: string; author?: string; eventId?: string}; query?: ReviewQuery; preview?: boolean; onProfile?: (pubkey: string) => void
  /** True when this person may review the item, for example after a delivered order. */
  canWrite?: () => boolean
  /** Signs and queues a public review event; resolves with the signed event. */
  publish?: (draft: ReturnType<typeof buildProductReviewDraft>) => Promise<any>
}

/** Product recommendations for one listing address; buyers with a delivered order can add theirs. */
export class ProductReviews {
  reviews = $state.raw<ProductReview[]>([])
  notice = $state('')
  retryHidden = $state(true)

  readonly target: string
  readonly query: ReviewQuery | undefined
  readonly preview: boolean
  private readonly onProfile: (pubkey: string) => void
  closed = false
  writing = $state(false)
  busy = $state(false)
  error = $state('')
  readonly canWrite: () => boolean
  private readonly eventId: string | undefined
  private readonly publishDraft: ProductReviewOptions['publish']
  private loaded = false
  private loading: Promise<void> | undefined
  private controller: AbortController | undefined
  private expiryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(target: string, {listing, query, preview = false, onProfile = () => {}, canWrite = () => false, publish}: ProductReviewOptions) {
    this.eventId = listing?.eventId
    this.target = target; this.query = query; this.preview = preview; this.onProfile = onProfile
    this.canWrite = () => !preview && !!publish && canWrite(); this.publishDraft = publish
  }

  async submit(recommend: boolean, body: string) {
    if (this.busy || !this.publishDraft) return false
    this.busy = true; this.error = ''
    try {
      const signed = await this.publishDraft(buildProductReviewDraft({address: this.target, eventId: this.eventId, recommend, body}))
      const review = parseProductReview(signed, this.target)
      // Show the reader's review immediately; the relay copy replaces it on the next read.
      this.show([review, ...this.reviews.filter(item => item.author !== review.author)])
      this.writing = false; this.notice = 'Thanks! Your review is public.'
      return true
    } catch (cause) { this.error = cause?.message || 'Could not publish your review.'; return false }
    finally { this.busy = false }
  }

  open(pubkey: string) { if (!this.closed) this.onProfile(pubkey) }

  /** Show reviews and drop each one when its expiration passes. */
  private show(reviews: ProductReview[]) {
    if (this.closed) return
    clearTimeout(this.expiryTimer)
    this.reviews = reviews
    const expirations = reviews.flatMap(review => review.event.tags.filter(tag => tag[0] === 'expiration').map(tag => Number(tag[1]) * 1000))
    if (expirations.length) this.expiryTimer = setTimeout(() => {
      if (this.closed) return
      this.show(productReviewsFromEvents(this.reviews.map(review => review.event), this.target))
      flushSync()
    }, Math.min(2147483647, Math.max(1, Math.min(...expirations) - Date.now())))
  }

  read(): Promise<void> {
    if (this.closed || this.preview) return Promise.resolve()
    if (this.loading) return this.loading
    if (!this.query) { this.notice = ''; this.loaded = true; this.show(this.reviews); return Promise.resolve() }
    const request = new AbortController(), query = this.query
    this.controller = request; this.notice = ''; this.retryHidden = true
    this.loading = (async () => {
      try {
        const result = await loadProductReviews(this.target, {query, signal: request.signal})
        if (this.closed || request.signal.aborted) return
        this.loaded = true
        this.notice = result.limited ? 'Showing recent reviews.' : ''
        this.retryHidden = !result.incomplete; this.show(result.reviews)
      } catch {
        if (!this.closed && !request.signal.aborted) { this.notice = ''; this.retryHidden = false; this.loaded = true; this.show(this.reviews) }
      } finally { this.loading = undefined }
    })()
    return this.loading
  }

  start() { return this.loaded ? Promise.resolve() : this.read() }
  destroy() { this.closed = true; this.controller?.abort(); clearTimeout(this.expiryTimer) }
}
