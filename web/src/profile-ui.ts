import { flushSync, mount, unmount } from 'svelte'
import { element } from './dom.ts'
import Page from './profile/Page.svelte'
import { ProfileState, type ProfileOptions } from './profile/state.svelte.ts'

export { knownFirstFollowers } from './profile/state.svelte.ts'

/** Relationship evidence, not an identity or seller-verification mark. */
export function createRelationshipBadge(relation) {
  if (!relation?.badge || relation.distance === null) return null
  const badge = element('span', '✓', `relationship-badge relationship-${relation.badge}`)
  const label = `${relation.description} · ${relation.distance} ${relation.distance === 1 ? 'step' : 'steps'} from the network root. Based on loaded public follow lists.`
  badge.title = label
  badge.setAttribute('aria-label', label)
  badge.setAttribute('role', 'img')
  return badge
}

export function setupProfiles(options: ProfileOptions) {
  const {page} = options
  const container = page ?? element('section', undefined, 'profile-page')
  container.setAttribute('aria-labelledby', 'public-profile-title')
  container.hidden = true
  container.replaceChildren()
  if (!page) document.body.append(container)
  const state = new ProfileState(options)
  state.page = container
  const view = mount(Page, {target: container, props: {profile: state}})
  flushSync()
  // Callers (and the router) read the page right after these calls.
  const open = (pubkey: string, settings?: {navigate?: boolean}) => { const pending = state.open(pubkey, settings); flushSync(); return pending }
  return {
    open,
    openReviews(pubkey: string) { void state.open(pubkey); state.select('reviews'); flushSync() },
    close() { state.close(); flushSync() },
    refreshReviews() { state.reviews?.refresh() },
    destroy() { state.destroyed = true; state.close(); flushSync(); void unmount(view); container.replaceChildren(); if (!page) container.remove() },
  }
}
