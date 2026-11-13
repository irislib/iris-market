import {setLoadingStatus} from '../loading-status.ts'
import {
  loadProfile, loadProfileFollowers, excludeKnownFollowers, readProfileMetadata, subscribeProfileMetadata,
  DEFAULT_SOCIAL_GRAPH_ROOT, type PublicProfile,
} from '../profiles.ts'
import {normalizePublicKey} from '../social.ts'
import {warmProfiles} from '../people.ts'
import {setupProfileReviews} from '../reviews-ui.ts'
import type {PublishReview, ReviewAccount, ReviewQuery} from '../reviews.ts'

export interface ProfileOptions {
  page?: HTMLElement; getRelays: () => string[]; getContext?: () => string; isPreview?: () => boolean
  onContextChange?: (key: string) => void; onAuthorListings?: (key: string) => void; onMessage?: (key: string) => void
  onNavigate?: (key: string) => void; onClose?: () => void; renderListings?: (key: string, host: HTMLElement) => void | (() => void)
  renderCollections?: (key: string, host: HTMLElement) => () => void
  queryReviews?: ReviewQuery; getReviewAccount?: () => ReviewAccount; publishReview?: PublishReview; onReviewSignIn?: () => void
  loadFollowers?: typeof loadProfileFollowers; loadProfileData?: typeof loadProfile
}
export type ProfileData = Awaited<ReturnType<typeof loadProfile>>
type Followers = Awaited<ReturnType<typeof loadProfileFollowers>>
export type ProfileView = {id: string; label: string; people?: {pubkey: string}[]; empty?: string; note?: string}

/** Keep signed graph observations first; relay omissions do not remove them. */
export function knownFirstFollowers<T extends {pubkey: string}>(known: readonly T[] = [], observed: readonly T[] = []): T[] {
  const seen = new Set<string>()
  return [...known, ...observed].filter(person => { if (seen.has(person.pubkey)) return false; seen.add(person.pubkey); return true })
}

export class ProfileState {
  key = $state<string | undefined>()
  profile = $state.raw<PublicProfile | undefined>()
  data = $state.raw<ProfileData | undefined>()
  followers = $state.raw<Followers | undefined>()
  followersError = $state('')
  view = $state('listings')
  reviews = $state.raw<ReturnType<typeof setupProfileReviews> | undefined>()
  reviewLabel = $state('Reviews')
  status: HTMLElement | undefined
  page: HTMLElement | undefined
  destroyed = false

  readonly options: ProfileOptions
  private generation = 0
  private controller: AbortController | undefined
  private unsubscribeMetadata: (() => void) | undefined
  private followersController: AbortController | undefined
  private followersGeneration = 0
  private followersLoading = false

  constructor(options: ProfileOptions) { this.options = options }

  get preview() { return this.options.isPreview?.() ?? false }
  relays() { return this.options.getRelays() }

  knownPeople = $derived.by(() => {
    const excluded = new Set(this.followers?.excludedKnownFollowers ?? [])
    return (this.data?.followedByKnown ?? []).filter(person => !excluded.has(person.pubkey))
  })
  followerPeople = $derived(knownFirstFollowers(this.knownPeople, this.followers?.items))
  followerLabel = $derived(this.followers || this.followerPeople.length ? `Followers ${this.followerPeople.length}` : 'Followers')
  views = $derived.by((): ProfileView[] => {
    const data = this.data
    return [
      {id: 'listings', label: 'Listings'},
      ...(this.options.renderCollections ? [{id: 'collections', label: 'Collections'}] : []),
      {id: 'reviews', label: 'Reviews'},
      {id: 'following', label: data ? `Following ${data.following.total ?? '—'}` : 'Following', people: data?.following.items,
        empty: data?.following.total === null ? 'Follow list unavailable.' : 'This public list is empty.',
        note: data?.following.truncated ? `Showing the first ${data.following.items.length} of ${data.following.total} follows.` : 'Latest signed follow list observed on your servers.'},
      {id: 'followers', label: this.followerLabel, people: this.followerPeople, empty: 'No followers found.',
        note: 'Observed followers only. Servers can omit records; this is not a total follower count.'},
    ]
  })

  setStatus(message: string, pending = false) { if (this.status) setLoadingStatus(this.status, message, pending) }

  select(id: string) {
    this.view = id
    if (id === 'followers' && !this.followersError) void this.requestFollowers()
  }

  private stopFollowers() {
    this.followersController?.abort()
    this.followersController = undefined
    this.followersGeneration++
    this.followersLoading = false
  }

  async requestFollowers() {
    if (this.followers || this.followersLoading || !this.key || this.preview) return
    const owner = this.key, run = this.generation, request = ++this.followersGeneration, abort = new AbortController()
    const load = this.options.loadFollowers ?? loadProfileFollowers
    this.followersController = abort
    this.followersLoading = true
    this.followersError = ''
    const stale = () => run !== this.generation || request !== this.followersGeneration || abort.signal.aborted || this.destroyed
    try {
      const value = await load(owner, {relays: this.relays(), signal: abort.signal})
      if (stale()) return
      this.followers = value
      if (this.data) this.data = {...this.data, relation: excludeKnownFollowers(this.data.relation, value.excludedKnownFollowers)}
    } catch {
      if (stale()) return
      this.followersError = 'Could not load followers.'
    } finally {
      if (run === this.generation && request === this.followersGeneration && !this.destroyed) {
        this.followersLoading = false
        this.followersController = undefined
      }
    }
  }

  close() {
    this.controller?.abort()
    this.unsubscribeMetadata?.()
    this.unsubscribeMetadata = undefined
    this.stopFollowers()
    this.followers = undefined
    this.data = undefined
    this.reviews?.close()
    this.reviews = undefined
    this.generation++
    this.key = undefined
    if (this.page) this.page.hidden = true
  }

  async open(pubkey: string, {navigate = true}: {navigate?: boolean} = {}) {
    if (this.destroyed) return
    let key: string
    try { key = normalizePublicKey(pubkey) } catch (error) { this.setStatus(error.message); return }
    const beforeNavigate = this.generation
    if (navigate) this.options.onNavigate?.(key)
    // A router may synchronously reopen this profile without navigation.
    if (this.generation !== beforeNavigate || this.destroyed) return
    this.close()
    this.followersError = ''
    this.view = 'listings'
    this.controller = new AbortController()
    const run = this.generation, signal = this.controller.signal
    this.key = key
    if (this.page) { this.page.hidden = false; this.page.scrollTop = 0 }
    this.profile = readProfileMetadata(key, {relays: this.relays()})
    const o = this.options
    this.reviews = setupProfileReviews({target: key, query: o.queryReviews, getAccount: o.getReviewAccount, publish: o.publishReview,
      preview: this.preview, onSignIn: o.onReviewSignIn, onProfile: other => void this.open(other),
      onSummary: value => { if (run === this.generation) this.reviewLabel = value.label }})
    this.reviewLabel = this.reviews.summary().label ?? 'Reviews'
    if (this.preview) { this.setStatus('Profiles are available in live mode.'); return }
    // The header is not a user row, so nothing else keeps a live lookup open for it.
    warmProfiles([key])
    void this.requestFollowers()
    this.setStatus(this.profile.eventId ? 'Loading connections…' : 'Loading profile…', true)
    // Metadata is useful immediately, even while graph discovery is pending.
    this.unsubscribeMetadata = subscribeProfileMetadata(profile => {
      if (run !== this.generation || this.destroyed || profile.pubkey !== this.key) return
      this.profile = profile
    }, {relays: this.relays()})
    try {
      const data = await (o.loadProfileData ?? loadProfile)(key, {relays: this.relays(), contextPubkey: o.getContext?.() || DEFAULT_SOCIAL_GRAPH_ROOT, signal})
      if (run !== this.generation || this.destroyed) return
      this.profile = readProfileMetadata(key, {relays: this.relays()})
      this.data = {...data, relation: excludeKnownFollowers(data.relation, this.followers?.excludedKnownFollowers)}
      this.setStatus('')
    } catch (error) {
      if (run === this.generation && error.name !== 'AbortError') this.setStatus(error.message || 'Could not load this profile.')
    }
  }

  async changeContext(key: string) {
    await this.options.onContextChange?.(key)
    void this.open(this.key, {navigate: false})
  }
}
