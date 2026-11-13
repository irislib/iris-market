import {flushNow} from './flush.ts';
import {follow, type Retention} from '../messaging/retention.ts'
import type {merchantNotices} from '../messaging/merchant-notice.ts'
import {editChatTimer, retentionLabel, localTimerDescription} from '../chat-timers-ui.ts'
import {durationLabel} from '../messaging/retention.ts'
import {createChatPickerState} from '../chat-picker-state.ts'
import {visibleChatMessageIds} from '../chat-visibility.ts'
import {configuredLocalTestMint} from '../wallet/mints.ts'
import {groupMessageThreads, messageThreadKey, type MessageContext} from '../message-context.ts'
import type {Surface} from '../surface.ts'
import {createProfileWithOptionalName} from '../profile-setup.ts'
import {createUnreadTracker, conversationNotifications, readingSurface} from '../notifications.ts'
import {createChatDrafts} from '../chat-drafts.ts'
import {captureInvitation} from '../asset-url.ts'
import {npubEncode} from 'nostr-tools/nip19'
import {createMessaging} from '../messaging/client.ts'
import {personFor, warmProfiles, resetPeople} from '../people.ts'
import {normalizePublicKey} from '../social.ts'
import {cacheProfileMetadata} from '../profiles.ts'

export type AccountState = Partial<ReturnType<ReturnType<typeof createMessaging>['state']>> & {status: string; devices: Array<{pubkey: string; current: boolean}>; conversations: Array<{pubkey: string; messages: any[]}>}
export interface AccountOptions {
  guestNotices?: ReturnType<typeof merchantNotices>; getMatchListings?: () => Parameters<typeof import('../private-matches.ts').matchCandidates>[2]
  renderEscrowTrades?: (host: HTMLElement, peer?: string, listing?: string) => void; listingTitle?: (coordinate: string) => string | undefined
  getRelays: () => string[]; getPublicRelays?: () => string[]; isPreview: () => boolean
  onIdentity?: (key: string, status: string, previous: string, pending: any[]) => void; onProfile?: (key: string) => void; onOrder?: (id: string) => void
  onToken?: (token: string) => unknown; onUnread?: (count: number) => void
  accountPage?: HTMLElement; onAccountPage?: () => void; onAccountClose?: () => void
  messagePage?: HTMLElement; onMessagePage?: (peer?: string) => void; onMessageClose?: () => void
  /** Tests substitute the messaging client; production always uses the real one. */
  createMessaging?: typeof createMessaging
}
type Defaulted = Required<Omit<AccountOptions, 'guestNotices' | 'accountPage' | 'messagePage' | 'createMessaging'>> & Pick<AccountOptions, 'guestNotices' | 'accountPage' | 'messagePage'>

export type AccountView = {
  heading: string; headingHidden: boolean; existing: boolean; signingOnly: boolean; busy: boolean
  loginHidden: boolean; unlockHidden: boolean; passwordHidden: boolean; readyHidden: boolean; openInviteHidden: boolean
  backupHidden: boolean; postingSignerHidden: boolean; owner?: string; displayName?: string; canSign: boolean
  devices: Array<{pubkey: string; label: string; revocable: boolean}>
  retentionDisabled: boolean; retentionText: string; receipts: Record<'delivered' | 'seen', boolean>; receiptsDisabled: boolean
}
export type ChatRowView = {pubkey: string; key: string; context?: MessageContext; pressed: boolean; title?: string; unread: boolean}
export type InboxView = {
  revision: number; threadMode: boolean; guest: boolean; rows: ChatRowView[]; escrow: 'inbox' | 'person' | null
  person: null | {pubkey: string; order?: {id: string; label: string}; listingNote?: string; noticeOnly: boolean; timer?: {seconds: number | null; label: string; disabled: boolean; description: string}}
  messages: any[]; empty: boolean; sendHidden: boolean; canSend: boolean; status: string; nearBottom: boolean
}
const emptyInbox = (): InboxView => ({revision: 0, threadMode: true, guest: false, rows: [], escrow: null, person: null, messages: [], empty: false, sendHidden: false, canSend: false, status: '', nearBottom: false})

// Matches the markup before the first render point.
const initialView: AccountView = {heading: 'Your profile', headingHidden: false, existing: false, signingOnly: false, busy: false, loginHidden: false, unlockHidden: true,
  passwordHidden: false, readyHidden: true, openInviteHidden: true, backupHidden: false, postingSignerHidden: true, canSign: false, devices: [],
  retentionDisabled: false, retentionText: 'Message retention', receipts: {delivered: true, seen: true}, receiptsDisabled: false}
const profileCopy = (value: unknown) => String(value).replace(/\baccounts\b/gi, 'profiles').replace(/\baccount\b/gi, 'profile')

/** Owns the profile dialog and Messages state; components render the snapshots taken at each render point. */
export class AccountController {
  // Snapshots, refreshed exactly where the imperative UI used to redraw.
  accountView = $state.raw<AccountView>(initialView)
  accountVersion = $state(0)
  inboxView = $state.raw<InboxView>(emptyInbox())
  accountError = $state('')
  accountStatus = $state('')
  connect = $state({hidden: true, link: '', href: undefined as string | undefined, label: 'Open signer'})
  receiptError = $state('')
  chatError = $state('')
  chatText = $state('')
  chatRecipient = $state('')
  sendDisabled = $state(false)
  sendHidden = $state(false)
  chatStatus = $state('')
  chatNewHidden = $state(false)

  state: AccountState = {status: 'signed-out', devices: [], conversations: []}
  busy = false
  selected: string | null = null
  selectedContext: MessageContext | undefined
  selectedThreadKey = 'general'
  threadMode = true
  pendingInbox = false
  signingOnly = false
  loginView = 'new'
  pendingInvite: string | null
  pendingDraft = ''
  inboxRevision = 0
  controller: AbortController | undefined
  guestRows: AccountState['conversations'] = []
  guestPolicy: Retention = follow
  guestTimer: ReturnType<typeof setTimeout> | undefined
  readFrame: number | undefined
  visibleProse = new Map<string, {original: string; node: HTMLElement}>()
  drafts = createChatDrafts()
  readonly pickerState = createChatPickerState()
  readonly unread: ReturnType<typeof createUnreadTracker>
  readonly readyListeners = new Set<() => void>()
  readonly stateListeners = new Set<(state: AccountState) => void>()
  readonly options: Defaulted
  readonly messaging: ReturnType<typeof createMessaging>
  restored: Promise<unknown>
  // Surfaces and the few elements read or focused imperatively.
  account: Surface
  inbox: Surface
  area: HTMLElement | undefined
  remoteOption: HTMLDetailsElement | undefined
  remoteForm: HTMLFormElement | undefined
  nameInput: HTMLInputElement | undefined
  textInput: HTMLTextAreaElement | undefined
  headerIdentity: {render(state: AccountState): void} = {render() {}}

  constructor(options: AccountOptions) {
    this.options = {getMatchListings: () => [], renderEscrowTrades: () => {}, listingTitle: () => undefined, getPublicRelays: options.getRelays,
      onIdentity: () => {}, onProfile: () => {}, onOrder: () => {}, onToken: () => {}, onUnread: () => {}, onAccountPage: () => {}, onAccountClose: () => {},
      onMessagePage: () => {}, onMessageClose: () => {}, ...options} as Defaulted
    this.unread = createUnreadTracker({kind: 'messages', onUnread: this.options.onUnread})
    try { this.threadMode = localStorage.getItem('market-message-grouping') !== 'people' } catch {}
    const incoming = captureInvitation(location.href, document.baseURI)
    this.pendingInvite = incoming?.invite ?? null
    if (incoming) history.replaceState(null, '', incoming.cleanURL)
    const {getRelays, getPublicRelays} = this.options
    this.messaging = (options.createMessaging ?? createMessaging)({developerMint: configuredLocalTestMint(), getRelays, getPublicRelays, onChange: value => this.changed(value as AccountState)})
  }

  get preview() { return this.options.isPreview() }
  selectionKey() { return this.selected ? this.selected + '|' + this.selectedThreadKey : '' }

  private changed(value: AccountState) {
    const previous = this.state.ownerPubkey
    this.state = value
    if (previous && (previous !== value.ownerPubkey || ['locked', 'signed-out'].includes(value.status))) {
      this.inboxRevision++; this.drafts = createChatDrafts(); this.pendingDraft = ''; this.selected = null; this.selectedContext = undefined
      this.chatText = ''; this.clearMessages()
    }
    this.syncUnread()
    for (const listener of this.stateListeners) listener(value)
    if (value.profileEvent) cacheProfileMetadata(value.profileEvent, {relays: this.options.getPublicRelays()})
    if (value.canSign) queueMicrotask(() => { for (const listener of this.readyListeners) listener() })
    warmProfiles([value.ownerPubkey, ...value.conversations.filter(c => !c.messages.length || c.messages.some(m => !m.id.startsWith('notice-'))).map(c => c.pubkey)].filter(Boolean))
    this.renderAccount(); this.renderInbox()
    this.options.onIdentity(value.ownerPubkey, value.status, previous, value.pendingListings || [])
    if (this.pendingInbox && value.status === 'ready') {
      this.pendingInbox = false; this.account.hide(); void this.showInbox()
      if (this.selected) void this.messaging.open(this.selected).catch(error => { this.chatError = error.message })
    }
  }

  async loadGuest() {
    const {guestNotices} = this.options
    if (!guestNotices || this.state.status !== 'signed-out') return
    const rows = await guestNotices.guestHistory(), policy = await guestNotices.guestRetention()
    if (this.state.status !== 'signed-out') return
    this.guestRows = rows; this.guestPolicy = policy; clearTimeout(this.guestTimer)
    if (policy.mode === 'expire' && rows.length) {
      const end = Math.min(...rows.flatMap(c => c.messages.map(m => m.createdAt + policy.seconds)))
      this.guestTimer = setTimeout(() => { void this.loadGuest().then(() => this.renderInbox()).catch(() => {}) }, Math.max(1, Math.min(2147483647, end * 1000 - Date.now())))
    }
  }

  fail = (error: any) => { this.accountError = profileCopy(error?.message || String(error)) }
  async withBusy<T>(task: () => Promise<T>) {
    if (this.busy) return
    this.busy = true; this.accountError = ''
    try { return await task() } catch (error) { this.fail(error); throw error } finally { this.busy = false; this.renderAccount() }
  }
  ensureLive() { if (this.preview) throw new Error('Switch to the live market to sign in.') }
  login(task: () => Promise<unknown>) { return this.withBusy(async () => { this.ensureLive(); await task(); this.signingOnly = false }).catch(() => {}) }

  syncUnread() {
    const visible = readingSurface(this.inbox)
    const visibleIds = this.area ? visibleChatMessageIds(this.inbox, this.area) : []
    this.unread.update(this.state.status === 'ready' && !this.preview ? this.state.ownerPubkey : null, conversationNotifications(this.state.conversations), visible ? this.selected : null, visibleIds)
  }
  scheduleSeen = () => {
    if (this.readFrame !== undefined) return
    this.readFrame = requestAnimationFrame(() => {
      this.readFrame = undefined
      if (this.state.status !== 'ready' || !this.selected) return
      const ids = visibleChatMessageIds(this.inbox, this.area); this.syncUnread()
      if (ids.length) void this.messaging.markSeen(this.selected, ids).catch(() => {})
    })
  }

  renderAccount() {
    const state = this.state, ready = state.status === 'ready', locked = state.status === 'locked', guestNotices = this.options.guestNotices
    if (locked && state.needsLogin) this.loginView = 'existing'
    const existing = this.loginView === 'existing' || this.signingOnly
    this.account?.classList.toggle('profile-onboarding', !ready && !locked && !existing && !this.pendingInvite)
    this.accountStatus = ''
    this.accountView = {
      heading: this.pendingInvite ? 'Private chat invitation' : locked ? 'Continue with your profile' : ready && !this.signingOnly ? 'Your profile' : 'Existing profile',
      headingHidden: !ready && !locked && !this.pendingInvite && !existing,
      existing, signingOnly: this.signingOnly, busy: this.busy,
      loginHidden: ready && !this.signingOnly || locked && !state.needsLogin,
      unlockHidden: !locked || !!state.needsLogin, passwordHidden: !state.password,
      readyHidden: !ready || this.signingOnly, openInviteHidden: !this.pendingInvite,
      backupHidden: state.mode !== 'local', postingSignerHidden: !!state.canSign,
      owner: state.ownerPubkey, displayName: state.displayName, canSign: !!state.canSign,
      devices: state.devices.map((device, index) => ({pubkey: device.pubkey, label: device.current ? 'This device' : `Linked device ${index + 1}`, revocable: !device.current && !!state.canSign})),
      retentionDisabled: this.preview || !(ready || state.status === 'signed-out' && !!guestNotices),
      retentionText: 'Message retention · ' + retentionLabel(ready ? state.retention ?? follow : this.guestPolicy),
      receipts: {delivered: state.receiptPreferences?.delivered !== false, seen: state.receiptPreferences?.seen !== false}, receiptsDisabled: !ready,
    }
    this.accountVersion++
    this.headerIdentity.render(state)
  }

  contextTitle(context?: MessageContext) {
    if (context?.order_id) { const title = this.state.orders?.find(o => o.id === context.order_id)?.items.map(i => i.title).join(', '); return title ? `Order · ${title}` : 'Order' }
    return context?.listing ? (this.options.listingTitle(context.listing) || 'Listing inquiry') : 'Conversation'
  }

  renderInbox() {
    const revision = ++this.inboxRevision
    this.syncUnread()
    if (!this.inbox.open) return
    const state = this.state, selected = this.selected, threadMode = this.threadMode
    const guest = state.status === 'signed-out', display = guest ? this.guestRows : state.conversations
    this.chatNewHidden = guest
    const rows: ChatRowView[] = display.flatMap(c => {
      const groups = threadMode ? groupMessageThreads(c.messages) : [{key: '*', context: undefined, messages: c.messages}]
      if (!groups.length) groups.push({key: 'general', context: undefined, messages: []})
      return groups.map(group => ({pubkey: c.pubkey, key: group.key, context: group.context, pressed: selected === c.pubkey && this.selectedThreadKey === group.key,
        title: threadMode ? this.contextTitle(group.context) : undefined, unread: !!this.unread.unread(c.pubkey, group.messages.map(m => m.id))}))
    })
    const context = this.selectedContext
    const allMessages = display.find(c => c.pubkey === selected)?.messages || []
    const noticeOnly = allMessages.length > 0 && allMessages.every(m => m.id.startsWith('notice-'))
    let person: InboxView['person'] = null
    if (selected) {
      person = {pubkey: selected, noticeOnly: !guest && noticeOnly}
      if (context?.order_id) { const id = context.order_id, order = state.orders?.find(o => o.id === id); person.order = {id, label: order?.items.map(i => i.title).join(', ') || 'View order'} }
      else if (context?.listing) person.listingNote = this.contextTitle(context)
      if (!guest && !noticeOnly) {
        const seconds = state.chatTimers?.[selected]?.seconds ?? null
        person.timer = {seconds, label: 'Conversation timer · ' + durationLabel(seconds), disabled: !state.canSend, description: localTimerDescription(state.retention ?? follow) + ' Each participant can keep their own copies.'}
      }
    }
    const messages = this.selectedThreadKey !== '*' ? allMessages.filter(m => messageThreadKey(m) === this.selectedThreadKey) : allMessages
    const area = this.area, nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100
    this.pickerState.capture(this.selectionKey(), area)
    const previousProse = this.visibleProse
    this.visibleProse = new Map()
    this.previousProse = previousProse
    this.inboxView = {revision, threadMode, guest, rows, person, messages, nearBottom,
      escrow: guest || context?.order_id ? null : selected ? 'person' : 'inbox',
      empty: !selected, sendHidden: !selected || guest, canSend: !!state.canSend, status: ''}
    this.sendHidden = !selected || guest; this.sendDisabled = !state.canSend
    flushNow()
    this.previousProse = new Map()
    this.pickerState.restoreFocus(area)
    if (nearBottom) area.scrollTop = area.scrollHeight
    this.scheduleSeen()
    this.chatStatus = !selected && this.pendingDraft ? 'Choose a conversation for your draft.' : guest ? 'Anonymous notice history on this device.' : selected && !state.canSend ? 'Messages will sync when connected.' : ''
  }
  previousProse = new Map<string, {original: string; node: HTMLElement}>()
  /** A receipt or reaction can redraw the inbox while someone reads a translation. */
  prose(message: {id: string; text: string}, make: (text: string) => HTMLElement) {
    const previous = this.previousProse.get(message.id)
    const prose = previous?.original === message.text ? previous : {original: message.text, node: make(message.text)}
    this.visibleProse.set(message.id, prose)
    return prose.node
  }
  clearMessages() { this.inboxView = {...this.inboxView, messages: [], empty: false, revision: -1} }
  /** Rendered rows may act only while their render is current. */
  active(revision: number) { return this.inbox.open && revision === this.inboxRevision && this.state.status === 'ready' }

  showAccount({posting = false} = {}) {
    if (this.preview) this.accountError = 'Switch to the live market to sign in.'
    this.signingOnly = false
    if (!this.busy) this.loginView = 'new'
    this.renderAccount(); flushNow(); this.account.showModal()
    if (!this.accountView.existing) this.nameInput?.focus()
    if (posting && this.state.status === 'ready' && !this.state.canSign) this.accountStatus = 'Connect a signer to post.'
    flushNow()
  }
  async showInbox() {
    if (this.state.status === 'signed-out' && this.options.guestNotices && !this.preview) await this.loadGuest()
    if (this.state.status !== 'ready' && !(this.state.status === 'signed-out' && this.guestRows.length)) { this.pendingInbox = true; this.showAccount(); return }
    this.renderInbox(); if (!this.inbox.open) this.inbox.showModal(); this.renderInbox()
  }
  selectChat(pubkey: string, proposal?: string, context?: MessageContext, threadKey = context ? messageThreadKey({context}) : this.threadMode ? 'general' : '*') {
    const nextKey = pubkey + '|' + threadKey
    this.chatText = this.drafts.select(nextKey, this.chatText, proposal); this.selected = pubkey; this.selectedContext = context; this.selectedThreadKey = threadKey
    if (this.inbox.open) this.options.onMessagePage(pubkey)
    if (this.pendingDraft) {
      const current = this.chatText, next = current.trim() ? current + '\n\n' + this.pendingDraft : this.pendingDraft
      if (next.length <= 8000) { this.chatText = next; this.drafts.select(this.selectionKey(), next); this.pendingDraft = '' }
      else this.chatError = 'Shorten this draft before adding the payment.'
    }
  }
  composeMessage(text: string) {
    if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('This message is too long to share.')
    const current = this.selected ? this.chatText : this.pendingDraft, next = current.trim() ? current + '\n\n' + text : text
    if (next.length > 8000) throw new Error('Shorten this draft before adding the payment.')
    if (this.selected) { this.chatText = next; this.drafts.select(this.selectionKey(), next) } else this.pendingDraft = next
    void this.showInbox(); if (this.selected) { flushNow(); this.textInput?.focus() }
  }
  async openChat(pubkey: string, {draft, context}: {draft?: string; context?: MessageContext} = {}) {
    if (this.preview) throw new Error('Switch to the live market to send messages.')
    this.selectChat(normalizePublicKey(pubkey), draft, context)
    if (this.state.status === 'signed-out' && !draft && this.options.guestNotices) {
      await this.loadGuest()
      if (this.guestRows.some(c => c.pubkey === this.selected)) { await this.showInbox(); return }
    }
    warmProfiles([this.selected])
    if (this.state.status !== 'ready') { this.pendingInbox = true; this.showAccount(); return }
    if (draft || !this.state.conversations.some(c => c.pubkey === this.selected && c.messages.some(m => m.id.startsWith('notice-')))) await this.messaging.open(this.selected)
    await this.showInbox()
  }

  // Profile dialog actions.
  showExisting() { this.loginView = 'existing'; this.accountError = ''; this.renderAccount() }
  backToNew(keyInput: HTMLInputElement) { this.controller?.abort(); this.loginView = 'new'; keyInput.value = ''; this.accountError = ''; this.renderAccount() }
  useExtension() { return this.login(() => this.signingOnly ? this.messaging.connectExtensionSigner() : this.messaging.loginWithExtension({})) }
  create(name: string) { return this.login(async () => { await createProfileWithOptionalName(this.messaging, name); resetPeople(); warmProfiles([this.state.ownerPubkey]) }) }
  /** The key goes straight from its field to messaging; it is never kept here. */
  loginWithKey(input: HTMLInputElement) { const key = input.value; input.value = ''; return this.login(() => this.messaging.loginWithKey({key})) }
  unlock(input: HTMLInputElement) { const password = input.value; input.value = ''; return this.login(() => this.messaging.unlock(password)) }
  connectRemote(bunker: string) {
    this.controller?.abort(); this.controller = new AbortController()
    const signal = this.controller.signal
    return this.login(async () => {
      await this.messaging[this.signingOnly ? 'connectPostingSigner' : 'loginWithSigner']({bunkerLink: bunker.trim() || undefined, signal,
        onConnectionLink: link => { this.connect.hidden = false; this.connect.link = link; this.connect.href = link },
        onAuthUrl: url => { if (new URL(url).protocol === 'https:') { this.connect.hidden = false; this.connect.href = url; this.connect.label = 'Approve connection' } }})
      this.controller = undefined; this.connect.hidden = true
    })
  }
  usePostingRemote() { this.signingOnly = true; this.loginView = 'existing'; this.renderAccount(); flushNow(); if (this.remoteOption) this.remoteOption.open = true }
  editDefaults() { const person = personFor(this.state.ownerPubkey); return {name: this.state.displayName || person.name || '', picture: person.pictureUrl || ''} }
  saveProfile(name: string, picture: string) {
    return this.login(async () => { await this.messaging.updateProfile({name, picture: picture.trim() || undefined}); resetPeople(); warmProfiles([this.state.ownerPubkey]); this.accountStatus = 'Profile saved' })
  }
  openInvite() { return this.withBusy(async () => { const peer = await this.messaging.acceptInvite(this.pendingInvite); this.pendingInvite = null; this.account.hide(); await this.openChat(peer) }).catch(() => {}) }
  openInboxFromAccount() { this.account.hide(); void this.showInbox() }
  openOwnProfile() { this.account.hide(); this.options.onProfile(this.state.ownerPubkey) }
  lock() { return this.login(() => this.messaging.lock()) }
  copyId() { return navigator.clipboard.writeText(npubEncode(this.state.ownerPubkey)).then(() => { this.accountStatus = 'Profile ID copied' }).catch(this.fail) }
  copyBackup() { return this.withBusy(async () => { await navigator.clipboard.writeText(await this.messaging.exportKey()); this.accountStatus = 'Backup key copied. Store it privately.' }).catch(() => {}) }
  copyInvite() { return this.withBusy(async () => { await navigator.clipboard.writeText(await this.messaging.inviteUrl()); this.accountStatus = 'Private invitation copied.' }).catch(() => {}) }
  revoke(pubkey: string) { return this.withBusy(() => this.messaging.revokeDevice(pubkey)).catch(() => {}) }

  // Messages settings.
  setReceipt(key: 'delivered' | 'seen', input: HTMLInputElement) {
    this.receiptError = ''
    void this.messaging.setReceiptPreferences({[key]: input.checked}).catch(() => { input.checked = this.state.receiptPreferences?.[key] !== false; this.receiptError = 'Could not save this preference. Try again.' })
  }
  async editRetention() {
    await this.restored; const owner = this.state.ownerPubkey
    const guest = this.state.status === 'signed-out'
    if (guest) await this.loadGuest()
    editChatTimer({policy: guest ? this.guestPolicy : this.state.retention ?? follow, save: async p => {
      if (guest) { if (this.state.status !== 'signed-out') throw Error('Profile changed.'); await this.options.guestNotices.guestHistory(p); await this.loadGuest(); this.renderInbox() }
      else { if (this.state.ownerPubkey !== owner || this.state.status !== 'ready') throw Error('Profile changed.'); await this.messaging.setRetention(p) }
      this.renderAccount()
    }})
  }

  // Messages actions.
  chooseRow(row: ChatRowView) { this.selectChat(row.pubkey, undefined, row.context, row.key); this.renderInbox() }
  setThreadMode(mode: boolean) {
    this.threadMode = mode
    try { localStorage.setItem('market-message-grouping', mode ? 'threads' : 'people') } catch {}
    if (this.selected) this.selectChat(this.selected)
    this.renderInbox()
  }
  startChat() {
    const input = this.chatRecipient.trim(); this.chatError = ''
    ;(async () => {
      this.selectChat(input.includes('://') ? await this.messaging.acceptInvite(input) : normalizePublicKey(input))
      await this.messaging.open(this.selected); this.chatRecipient = ''; this.renderInbox()
    })().catch(error => { this.chatError = error.message })
  }
  send() {
    const text = this.chatText.trim(), peer = this.selected, context = this.selectedContext, key = this.selectionKey()
    if (!text || !peer) return
    this.sendDisabled = true; this.chatError = ''
    this.messaging.send(peer, text, context).then(() => { this.drafts.clear(key); if (this.selectionKey() === key && this.chatText.trim() === text) this.chatText = '' })
      .catch(error => { this.chatError = error.message }).finally(() => { this.sendDisabled = !this.state.canSend })
  }
  react(revision: number, item: HTMLElement, messageId: string, emoji: string) {
    if (!this.selected || !this.active(revision)) return
    const openPicker = item.querySelector<HTMLDetailsElement>('.chat-reaction-picker')
    if (openPicker) openPicker.open = false
    void this.messaging.react(this.selected, messageId, emoji).catch(error => { this.chatError = error.message })
  }
  editConversationTimer(peer: string, seconds: number | null) { editChatTimer({seconds, save: value => this.messaging.setChatTimer(peer, value)}) }
  showPerson(pubkey: string) { this.inbox.hide(); this.options.onProfile(pubkey) }
  showOrder(id: string) { this.inbox.hide(); this.options.onOrder(id) }
  inboxClosed() { this.pickerState.reset(); this.inboxRevision++; this.visibleProse.clear(); this.clearMessages(); this.syncUnread() }
  refreshUnread = () => { if (!document.hidden) void this.messaging.refreshHistory().catch(() => {}); this.syncUnread(); if (this.inbox.open) this.renderInbox() }
}
