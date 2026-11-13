import {flushSync, mount, unmount} from 'svelte'
import {element} from './dom.ts'
import ProfilePanel from './reviews/ProfilePanel.svelte'
import {ProfileReviews, type ReviewPanelOptions} from './reviews/profile.svelte.ts'

export type {ReviewSummaryView} from './reviews/profile.svelte.ts'

/** The form stays mounted through profile metadata refreshes and tab changes. */
export function setupProfileReviews(options: ReviewPanelOptions) {
  const panel = element('section', undefined, 'profile-reviews')
  const state = new ProfileReviews(options)
  const view = mount(ProfilePanel, {target: panel, props: {reviews: state}})
  state.start()
  // Callers read the panel and its summary right after these calls.
  flushSync()
  return {
    element: panel,
    summary: () => state.summary(),
    refresh() { state.refresh(); flushSync() },
    close() { state.close(); flushSync(); void unmount(view) },
  }
}
