import {getEventHash} from 'nostr-tools/pure'
import {buildReviewDraft, cachedReviews, effectiveReviews, loadReviews, mergeReviews, parseReview, rememberReview, reviewSummary} from '../reviews.ts'
import type {PublishReview, Review, ReviewAccount, ReviewQuery} from '../reviews.ts'

export interface ReviewSummaryView {label: string; count: number}
export interface ReviewPanelOptions {
  target: string; query?: ReviewQuery; getAccount?: () => ReviewAccount; publish?: PublishReview; preview?: boolean
  onSignIn?: () => void; onProfile?: (pubkey: string) => void; onSummary?: (summary: ReviewSummaryView) => void
}

/** Profile reviews: lookup, local queue merge and the explicit publish form. */
export class ProfileReviews {
  // Accounts live outside Svelte; bump this to re-read them.
  version = $state(0)
  reviews = $state.raw<Review[]>([])
  notice = $state('')
  retryHidden = $state(true)
  formHidden = $state(true)
  rating = $state(0)
  text = $state('')
  error = $state('')
  busy = $state(false)
  submitLabel = $state('Publish review')

  readonly target: string
  readonly preview: boolean
  readonly query: ReviewQuery | undefined
  readonly publish: PublishReview | undefined
  readonly getAccount: () => ReviewAccount
  readonly onSignIn: () => void
  readonly onProfile: (pubkey: string) => void
  readonly onSummary: (summary: ReviewSummaryView) => void
  private closed = false
  private formOwner: string | undefined
  private loadController: AbortController | undefined
  private loading: Promise<void> | undefined
  private reloadAfter = false
  private pendingKey = ''
  private accountOwner: string | undefined

  constructor({target, query, getAccount = () => ({canSign: false}), publish, preview = false, onSignIn = () => {}, onProfile = () => {}, onSummary = () => {}}: ReviewPanelOptions) {
    this.target = target; this.query = query; this.getAccount = getAccount; this.publish = publish; this.preview = preview
    this.onSignIn = onSignIn; this.onProfile = onProfile; this.onSummary = onSummary
  }

  view = $derived.by(() => {
    void this.version
    const account = this.getAccount()
    return {
      writeHidden: this.preview || account.owner === this.target,
      writeLabel: this.ownReview(account.owner) ? 'Edit review' : 'Write review',
      summary: this.summary().label,
      shown: effectiveReviews(this.reviews),
    }
  })

  ownReview(owner: string | undefined) { return effectiveReviews(this.reviews).find(review => review.author === owner) }
  summary(): ReviewSummaryView {
    const value = reviewSummary(this.reviews)
    return {count: value.count, label: value.count ? `★ ${value.average.toFixed(1)} · ${value.count} ${value.count === 1 ? 'review' : 'reviews'}` : '0 reviews'}
  }
  private draw() { this.version++; this.onSummary(this.summary()) }

  start() {
    this.refresh()
    if (this.preview) this.notice = 'Reviews are available in live mode.'
    else queueMicrotask(() => void this.read())
  }

  async read(): Promise<void> {
    if (this.closed || this.preview) return
    if (this.loading) { this.reloadAfter = true; return this.loading }
    if (!this.query) { this.notice = ''; this.retryHidden = true; this.draw(); return }
    const controller = new AbortController(), query = this.query
    this.loadController = controller; this.notice = ''; this.retryHidden = true
    this.loading = (async () => {
      try {
        const result = await loadReviews(this.target, {query, signal: controller.signal, pending: this.getAccount().pending})
        if (this.closed || controller.signal.aborted) return
        this.reviews = mergeReviews(result.reviews, cachedReviews(this.target, this.getAccount().pending))
        this.notice = result.limited ? 'Showing recent reviews.' : ''; this.retryHidden = !result.incomplete; this.draw()
      } catch {
        if (!this.closed && !controller.signal.aborted) {
          this.notice = ''; this.retryHidden = false
          this.reviews = mergeReviews(this.reviews, cachedReviews(this.target, this.getAccount().pending)); this.draw()
        }
      } finally {
        this.loading = undefined
        if (!this.closed && this.reloadAfter) { this.reloadAfter = false; void this.read() }
      }
    })()
    return this.loading
  }

  refresh() {
    if (this.closed) return
    const account = this.getAccount(), nextKey = (account.pending ?? []).map(event => event.id).sort().join(',')
    if (this.formOwner && account.owner !== this.formOwner) { this.formHidden = true; this.text = ''; this.formOwner = undefined; this.error = '' }
    const syncChanged = account.owner === this.accountOwner && this.pendingKey !== nextKey && !!this.pendingKey
    this.pendingKey = nextKey; this.accountOwner = account.owner
    this.reviews = mergeReviews(this.reviews, cachedReviews(this.target, account.pending)); this.draw()
    if (syncChanged) void this.read()
  }

  /** Returns true when the form opened. */
  openForm() {
    const account = this.getAccount()
    if (!account.owner || !account.canSign || !this.publish) { this.onSignIn(); return false }
    if (account.owner === this.target) return false
    const previous = this.ownReview(account.owner)
    this.formOwner = account.owner; this.text = previous?.body ?? ''; this.error = ''; this.rating = previous?.rating ?? 0
    this.submitLabel = previous ? 'Update review' : 'Publish review'; this.formHidden = false
    return true
  }
  cancel() { this.formHidden = true; this.error = '' }

  async submit() {
    if (this.busy || this.closed) return
    const account = this.getAccount(), publish = this.publish
    if (!account.canSign || !account.owner || account.owner !== this.formOwner || !publish) { this.error = 'Your profile changed. Open the review form again.'; return }
    const previous = this.ownReview(account.owner), now = Math.max(Math.floor(Date.now() / 1000), (previous?.event.created_at ?? 0) + 1)
    let draft
    try { draft = buildReviewDraft({target: this.target, author: account.owner, rating: this.rating, body: this.text, subject: previous?.subject, createdAt: previous?.createdAt, now}) }
    catch (cause) { this.error = cause.message; return }
    this.busy = true; this.error = ''
    try {
      const receipt = await publish(draft)
      if (this.closed) return
      if (this.getAccount().owner !== account.owner) throw new Error('Your profile changed. Reopen reviews to see the result.')
      const parsed = parseReview(receipt.event, this.target)
      if (parsed.author !== account.owner || parsed.id !== getEventHash({...draft, pubkey: account.owner})) throw new Error('The signer returned a different review.')
      const review: Review = {...parsed, delivery: receipt.delivery === 'published' ? 'published' : 'queued'}
      rememberReview(review); this.reviews = mergeReviews(this.reviews, [review])
      this.formHidden = true; this.notice = review.delivery === 'queued' ? 'Review saved. Waiting to publish.' : 'Review published.'; this.draw()
    } catch (cause) { if (!this.closed) this.error = cause.message || 'Could not save this review. Try again.' }
    finally { this.busy = false; if (!this.closed) this.draw() }
  }

  close() { this.closed = true; this.loadController?.abort(); this.text = '' }
}
