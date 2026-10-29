import { byId, element as domElement, formFields } from './dom.ts';
import { npubEncode } from 'nostr-tools/nip19'
import { loadProfile, profileLabel, DEFAULT_SOCIAL_GRAPH_ROOT, DEFAULT_SOCIAL_GRAPH_LABEL } from './profiles.ts'
import { normalizePublicKey } from './social.ts'
import { createAvatar, createUserRow, warmProfiles } from './people.ts'

const element = domElement

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

export function setupProfiles({ getRelays, getContext = () => DEFAULT_SOCIAL_GRAPH_ROOT, isPreview = () => false, onContextChange = () => {}, onAuthorListings = () => {}, onMessage = () => {} }: {getRelays:()=>string[];getContext?:()=>string;isPreview?:()=>boolean;onContextChange?:(key:string)=>void;onAuthorListings?:(key:string)=>void;onMessage?:(key:string)=>void}) {
  const dialog = element('dialog', undefined, 'profile-dialog')
  dialog.id = 'public-profile-dialog'
  dialog.setAttribute('aria-labelledby', 'public-profile-title')
  const close = element('button', '×', 'dialog-close icon-button')
  close.setAttribute('aria-label', 'Close profile')
  close.onclick = () => dialog.close()
  const body = element('div', undefined, 'profile-content')
  const status = element('p', '', 'profile-status muted')
  status.setAttribute('role', 'status')
  dialog.append(close, body, status)
  document.body.append(dialog)
  let controller, generation = 0, currentKey, destroyed = false

  const route = (pubkey, clear = false) => {
    const url = new URL(location.href)
    if (clear) url.searchParams.delete('profile')
    else { url.searchParams.set('profile', npubEncode(pubkey)); url.searchParams.delete('listing') }
    history.replaceState(null, '', url)
  }
  const peopleList = (people, emptyText) => {
    const list = element('div', undefined, 'profile-people')
    if (!people.length) { list.append(element('p', emptyText, 'muted small')); return list }
    for (const person of people) {
      const button = createUserRow(person.pubkey, { size:34, className:'profile-person', onClick:() => open(person.pubkey) })
      list.append(button)
    }
    return list
  }
  const render = data => {
    const profile = data.profile
    body.replaceChildren()
    const identity = element('div', undefined, 'profile-identity')
    const name = element('h2', profile.name)
    name.id = 'public-profile-title'
    const badge = createRelationshipBadge(data.relation)
    if (badge) name.append(badge)
    const heading = element('div')
    heading.append(name)
    identity.append(createAvatar(profile.pubkey, {size:76}), heading)
    body.append(identity)
    if (profile.about) body.append(element('p', profile.about, 'profile-about'))
    if (profile.website) {
      const link = element('a', new URL(profile.website).hostname, 'profile-website')
      link.href = profile.website; link.target = '_blank'; link.rel = 'noopener noreferrer'
      body.append(link)
    }
    if (profile.nip05) body.append(element('p', `${profile.nip05} · Self-declared address`, 'profile-address muted small'))
    const connection = element('div', undefined, 'profile-connection')
    connection.append(element('p', data.relation.description))
    if (data.relation.distance !== null) connection.append(element('p', `Follow distance: ${data.relation.distance}`, 'small muted'))
    if (data.mutualFollowing) connection.append(element('p', `Mutual follows with ${data.contextLabel}`, 'small'))
    else if (data.followsContext) connection.append(element('p', `Follows ${data.contextLabel}`, 'small'))
    connection.append(element('p', `Network: ${data.contextLabel}`, 'small muted'))
    body.append(connection)

    const actions = element('div', undefined, 'profile-actions')
    const listings = element('button', 'Listings', 'button secondary')
    listings.onclick = () => { dialog.close(); onAuthorListings(profile.pubkey) }
    const copy = element('button', 'Copy user ID', 'button secondary')
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(npubEncode(profile.pubkey)); status.textContent = 'User ID copied' }
      catch { status.textContent = npubEncode(profile.pubkey) }
    }
    const share = element('button', 'Copy profile link', 'text-button')
    share.onclick = async () => {
      try { await navigator.clipboard.writeText(location.href); status.textContent = 'Profile link copied' }
      catch { status.textContent = 'Copy the address from your browser.' }
    }
    const message = element('button', 'Message', 'button primary'); message.onclick = () => { dialog.close(); onMessage(profile.pubkey) };
    actions.append(message, listings, copy, share); body.append(actions)

    const tabs = element('div', undefined, 'profile-tabs')
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Profile connections')
    const panel = element('div', undefined, 'profile-list-panel')
    panel.id = 'profile-list-panel'; panel.setAttribute('role', 'tabpanel')
    const views = [
      ['known', `Known ${data.followedByKnown.length}`, data.followedByKnown, 'No known followers found in the loaded lists.', `Followed by people ${data.contextLabel} follows. Only ${data.coverage.secondHopLoaded} of ${data.coverage.directFollows ?? '?'} follow lists were loaded.`],
      ['following', `Following ${data.following.total ?? '—'}`, data.following.items, data.following.total === null ? 'Follow list unavailable.' : 'This public list is empty.', data.following.truncated ? `Showing the first ${data.following.items.length} of ${data.following.total} follows.` : 'Latest signed follow list observed on your servers.'],
      ['followers', `Followers ${data.followers.observedCount}`, data.followers.items, 'No followers found in this lookup.', 'Observed followers only. Servers can omit records; this is not a total follower count.'],
    ]
    const select = (view, button) => {
      for (const tab of tabs.children) { tab.setAttribute('aria-selected', String(tab === button)); (tab as HTMLElement).tabIndex = tab === button ? 0 : -1 }
      panel.setAttribute('aria-labelledby', button.id)
      panel.replaceChildren(element('p', view[4], 'profile-list-note small muted'), peopleList(view[2], view[3]))
    }
    for (const view of views) {
      const tab = element('button', view[1]); tab.id = `profile-tab-${view[0]}`
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id)
      tab.onclick = () => select(view, tab)
      tab.onkeydown = event => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const current = [...tabs.children].indexOf(tab), total = views.length
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? total - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + total) % total
        ;(tabs.children[index] as HTMLButtonElement).click(); (tabs.children[index] as HTMLButtonElement).focus()
      }
      tabs.append(tab)
    }
    select(views[data.followedByKnown.length ? 0 : 1], tabs.children[data.followedByKnown.length ? 0 : 1])
    body.append(tabs, panel)

    const network = element('details', undefined, 'profile-network')
    network.append(element('summary', 'Network settings'))
    const form = element('form')
    const label = element('label', 'Public profile for connections'); label.htmlFor = 'profile-context'
    const input = element('input'); input.id = 'profile-context'; input.placeholder = 'Public user ID'; input.autocomplete = 'off'; input.spellcheck = false
    input.value = npubEncode(data.contextPubkey)
    const error = element('p', '', 'error small'); error.setAttribute('role', 'alert')
    const apply = element('button', 'Use profile', 'button secondary'); apply.type = 'submit'
    const reset = element('button', `Use ${DEFAULT_SOCIAL_GRAPH_LABEL}`, 'text-button'); reset.type = 'button'
    const update = async key => {
      try { await onContextChange(key); open(currentKey) } catch { error.textContent = 'Could not change the network profile.' }
    }
    form.onsubmit = event => { event.preventDefault(); try { update(normalizePublicKey(input.value)) } catch (cause) { error.textContent = cause.message } }
    reset.onclick = () => update(DEFAULT_SOCIAL_GRAPH_ROOT)
    form.append(label, input, error, apply, reset)
    network.append(form, element('p', 'Uses public follow lists. This does not sign in or follow anyone.', 'small muted'))
    body.append(network)
    const warnings = [...new Set(data.coverage.warnings)]
    status.textContent = warnings.length ? warnings.join(' ') : 'Connections reflect a partial public graph, not identity verification.'
  }

  async function open(pubkey, updateRoute = true) {
    if (destroyed) return
    let key
    try { key = normalizePublicKey(pubkey) } catch (error) { status.textContent = error.message; return }
    controller?.abort(); controller = new AbortController(); const run = ++generation
    currentKey = key
    if (updateRoute) route(key)
    body.replaceChildren(element('h2', 'Profile'))
    ;(body.firstChild as HTMLElement).id = 'public-profile-title'
    if (!dialog.open) dialog.showModal()
    dialog.scrollTop = 0
    if (isPreview()) { status.textContent = 'Profiles are available in live mode.'; return }
    status.textContent = 'Loading profile…'
    try {
      const data = await loadProfile(key, { relays: getRelays(), contextPubkey: getContext() || DEFAULT_SOCIAL_GRAPH_ROOT, signal: controller.signal })
      if (run !== generation || destroyed) return
      render(data)
    } catch (error) { if (run === generation && error.name !== 'AbortError') status.textContent = error.message || 'Could not load this profile.' }
  }
  dialog.addEventListener('close', () => { controller?.abort(); generation++; route(null, true) })
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return
    const box = dialog.getBoundingClientRect()
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close()
  })
  const fromRoute = () => {
    const key = new URLSearchParams(location.search).get('profile')
    if (key) open(key, false)
    else if (dialog.open) dialog.close()
  }
  window.addEventListener('popstate', fromRoute)
  queueMicrotask(fromRoute)
  return { open, destroy() { destroyed = true; generation++; controller?.abort(); window.removeEventListener('popstate', fromRoute); dialog.remove() } }
}
