import {nip19} from 'nostr-tools'
import {element} from './dom.ts'
import {nameFor} from './people.ts'
import {listingURL} from './routes.ts'
import {matchCandidates, type MatchAction, type MatchView} from './private-matches.ts'

export function setupPrivateMatches(api, getListings, messages: HTMLElement) {
  const section = element('details', undefined, 'settings-section')
  const label = element('label', 'Find a match privately', 'checkbox-label')
  const toggle = element('input')
  toggle.type = 'checkbox'
  label.prepend(toggle)
  const settingsLink = element('button', 'Open private matching')
  const settingsError = element('p', undefined, 'error')
  section.append(element('summary', 'Private matching'), label,
    element('p', 'Exchange private offers and requests with a helper you choose. Open Private matches in Messages to return.'),
    settingsLink, settingsError)
  document.querySelector('#preferences-dialog')?.append(section)

  const inboxLink = element('button', 'Private matches', 'button secondary match-inbox-link')
  messages.querySelector('.chat-shell')?.before(inboxLink)
  const dialog = element('dialog', undefined, 'match-dialog')
  dialog.setAttribute('aria-labelledby', 'private-match-heading')
  const heading = element('h2', 'Private matches')
  heading.id = 'private-match-heading'
  const close = element('button', '×', 'dialog-close icon-button')
  close.setAttribute('aria-label', 'Close private matches')
  close.onclick = () => dialog.close()
  const views = element('div', undefined, 'match-switch')
  views.setAttribute('role', 'group')
  views.setAttribute('aria-label', 'Private matches view')
  const mine = element('button', 'My matches')
  const helping = element('button', 'Helping')
  views.append(mine, helping)
  const error = element('p', undefined, 'error')
  error.setAttribute('role', 'alert')
  const rows = element('div', undefined, 'match-rows')
  const compose = element('details', undefined, 'match-compose')
  const helper = element('input'), summary = element('textarea'), side = element('select')
  helper.placeholder = 'Helper’s npub or public key'
  helper.setAttribute('aria-label', 'Helper')
  helper.autocomplete = 'off'
  summary.placeholder = 'e.g. Looking for a cargo bike with two seats'
  summary.setAttribute('aria-label', 'Shareable summary')
  summary.maxLength = 200
  for (const [value, name] of [['request', 'I’m looking for'], ['offer', 'I’m offering']]) {
    const option = element('option', name)
    option.value = value
    side.append(option)
  }
  side.setAttribute('aria-label', 'Offer or request')
  const contacts = element('select')
  contacts.setAttribute('aria-label', 'Choose from your conversations')
  contacts.onchange = () => { if (contacts.value) helper.value = contacts.value }
  const deviceStatus = element('p', undefined, 'small muted')
  const send = element('button', 'Send to helper privately', 'button primary')
  send.onclick = async () => {
    try {
      const raw = helper.value.trim()
      const decoded = raw.startsWith('npub1') ? nip19.decode(raw) : null
      const pubkey = decoded?.type === 'npub' ? decoded.data : raw
      if (await act({op:'share', helper:pubkey, side:side.value as 'offer'|'request', summary:summary.value})) {
        summary.value = ''
        compose.open = false
      }
    } catch { error.textContent = 'Enter the helper’s public key.' }
  }
  compose.append(element('summary', 'Ask a helper'), element('p',
    'Your helper may show this summary privately to someone with a possible match. Leave names and contact details out. It expires in seven days.'),
    side, contacts, helper, summary, deviceStatus, send)
  dialog.append(close, heading, views, compose, error, rows)
  document.body.append(dialog)
  let selected = '', busy = false, helperView = false, owner = ''

  async function act(action: MatchAction, listing?) {
    if (busy) return false
    busy = true
    error.textContent = ''
    settingsError.textContent = ''
    try { await api.messaging.privateMatch(action, listing); return true }
    catch (e) {
      (dialog.open ? error : settingsError).textContent = e instanceof Error ? e.message : 'Could not save this change.'
      return false
    } finally { busy = false; sync() }
  }
  function action(title: string, fn: () => void) {
    const button = element('button', title, 'button secondary')
    button.type = 'button'
    button.onclick = fn
    return button
  }
  function row(parent: HTMLElement, title: string, detail: string, ...actions: HTMLElement[]) {
    const card = element('div', undefined, 'match-card')
    card.append(element('strong', title), element('p', detail, 'small muted'), ...actions)
    parent.append(card)
    return card
  }
  const until = (at: number) => new Date(at * 1000).toLocaleDateString()
  function render(v: MatchView) {
    rows.replaceChildren()
    compose.hidden = helperView
    mine.setAttribute('aria-pressed', String(!helperView))
    helping.setAttribute('aria-pressed', String(helperView))
    if (helperView) {
      for (const [proposal, pair] of Object.entries(v.pairs)) {
        const ready = pair.votes.every(vote => vote === true)
        const status = pair.introduced ? 'Introduction started' : pair.votes.includes(false) ? 'Declined' : ready ? 'Both agreed' : 'Waiting for replies'
        row(rows, pair.entries.map(id => v.received[id]?.summary).join(' · '), status,
          ...(ready && !pair.introduced ? [action('Introduce privately', () => void act({op:'introduce', proposal}))] : []))
      }
      for (const entry of Object.values(v.received)) {
        const card = row(rows, entry.summary,
          (entry.side === 'offer' ? 'Offer from ' : 'Request from ') + nameFor(entry.peer) + ' · Expires ' + until(entry.expires_at),
          action('Find matches', () => { selected = entry.id; render(v) }))
        if (selected !== entry.id) continue
        const inventory = getListings()
        const candidates = matchCandidates(v, entry.id, inventory).filter(c =>
          c.kind !== 'private' || !Object.values(v.pairs).some(p => p.entries.includes(entry.id) && p.entries.includes(c.id)))
        if (!candidates.length) card.append(element('p', 'No new matches right now.', 'small muted'))
        for (const candidate of candidates) {
          const isPrivate = candidate.kind === 'private'
          row(card, candidate.summary, isPrivate ? 'Shared privately with you' : 'Public listing',
            action(isPrivate ? 'Ask both privately' : 'Send public listing privately', () => {
              if (isPrivate) void act({op:'suggest', left:entry.id, right:candidate.id})
              else void act({op:'send_public', entry:entry.id, listing:candidate.id}, inventory.find(item => item.id === candidate.id))
            }))
        }
      }
      if (!rows.childElementCount) rows.append(element('p', 'Offers and requests shared with you will appear here.'))
      return
    }
    for (const [proposal, p] of Object.entries(v.interests)) {
      const buttons: HTMLElement[] = []
      if (p.vote === null) {
        buttons.push(action('Agree to introduction', () => void act({op:'vote', proposal, accept:true})),
          action('Decline', () => void act({op:'vote', proposal, accept:false})))
      }
      if (p.contact) buttons.push(action('Open private chat', () => { dialog.close(); void api.openChat(p.contact) }))
      row(rows, p.summary, p.contact ? 'You have been introduced.' : p.vote === null ?
        'If you both agree, your helper can share your Iris messaging identity with the other person.' :
        p.vote ? 'You agreed. Waiting for the introduction.' : 'You declined.', ...buttons)
    }
    for (const lead of Object.values(v.public_leads)) {
      const link = element('a', 'Open public listing')
      try { link.href = listingURL(lead.listing.replace(/^30402:/, '')) } catch { continue }
      row(rows, lead.title, 'Public listing from your helper', link)
    }
    for (const entry of Object.values(v.sent)) {
      row(rows, entry.summary, (entry.side === 'offer' ? 'Your offer' : 'Your request') + ' with ' + nameFor(entry.peer) + ' · Expires ' + until(entry.expires_at),
        action('Withdraw', () => void act({op:'withdraw', entry:entry.id})))
    }
    if (!rows.childElementCount) rows.append(element('p', 'Your private offers, requests and replies will appear here.'))
  }
  function sync() {
    const state = api.state(), v = api.messaging.privateMatchView()
    if (owner !== state.ownerPubkey && dialog.open) dialog.close()
    owner = state.ownerPubkey
    toggle.checked = !!v
    toggle.disabled = state.status !== 'ready'
    settingsLink.hidden = inboxLink.hidden = !v
    if (!dialog.open) return
    if (!v) { dialog.close(); return }
    const peers = state.conversations.map(c => c.pubkey)
    const names = peers.map(key => nameFor(key) + ' · ' + key.slice(-6))
    if (contacts.options.length !== peers.length + 1 || peers.some((key, i) =>
      contacts.options[i+1]?.value !== key || contacts.options[i+1]?.text !== names[i])) {
      contacts.replaceChildren(new Option('Choose from your conversations', ''), ...peers.map((key, i) => new Option(names[i], key)))
    }
    contacts.value = peers.includes(helper.value) ? helper.value : ''
    contacts.hidden = !peers.length
    send.disabled = !state.canSend
    deviceStatus.textContent = state.canSend ? '' : 'Waiting for device authorization before sending.'
    render(v)
  }
  function open() {
    const v: MatchView | null = api.messaging.privateMatchView()
    if (!v) return
    helperView = !Object.keys(v.interests).length && !!Object.keys(v.received).length
    dialog.showModal()
    sync()
  }
  mine.onclick = () => { helperView = false; sync() }
  helping.onclick = () => { helperView = true; sync() }
  toggle.onchange = () => void act({op:'enable', enabled:toggle.checked})
  dialog.addEventListener('close', () => {
    selected = ''; helper.value = ''; summary.value = ''; side.value = 'request'; compose.open = false
    error.textContent = ''; rows.replaceChildren(); contacts.replaceChildren()
  })
  settingsLink.onclick = inboxLink.onclick = open
  api.onState(sync)
  sync()
}
