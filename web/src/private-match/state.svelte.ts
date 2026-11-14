import type {MatchAction, MatchView} from '../private-matches.ts'
import type {AliasChat} from './aliases.ts'

export type PrivateMatchApi = {
  state(): {ownerPubkey?: string; status: string; canSend?: boolean; conversations: {pubkey: string}[]}
  onState(listener: () => void): unknown
  openChat(pubkey: string): unknown
  messaging: {
    privateMatchView(): MatchView | null
    privateMatch(action: MatchAction, listing?: unknown): Promise<void>
    privateMatchChats?(): AliasChat[]
    privateMatchSend?(chat: string, text: string): Promise<void>
    privateMatchRead?(chat: string): Promise<void>
  }
}

// Shared by the settings toggle, the Messages link and the dialog.
export class PrivateMatchState {
  view = $state.raw<MatchView | null>(null)
  chats = $state.raw<AliasChat[]>([])
  openChat = $state('')
  /** New messages per alias chat since it was last opened on this device. */
  unread = $state.raw<Record<string, number>>({})
  unreadTotal = $derived(Object.values(this.unread).reduce((a, b) => a + b, 0))
  owner = $state('')
  ready = $state(false)
  canSend = $state(false)
  peers = $state.raw<string[]>([])
  dialogOpen = $state(false)
  helperView = $state(false)
  error = $state('')
  settingsError = $state('')
  busy = false

  readonly api: PrivateMatchApi

  constructor(api: PrivateMatchApi) { this.api = api }

  sync() {
    const state = this.api.state()
    const owner = state.ownerPubkey ?? ''
    if (this.owner !== owner) this.dialogOpen = false
    this.owner = owner
    this.ready = state.status === 'ready'
    this.canSend = !!state.canSend
    this.peers = state.conversations.map(c => c.pubkey)
    this.view = this.api.messaging.privateMatchView()
    this.chats = this.api.messaging.privateMatchChats?.() ?? []
    if (!this.view) this.dialogOpen = false
    if (!this.dialogOpen) this.openChat = ''
    if (this.openChat) this.markRead(this.openChat)
    this.countUnread()
  }

  markRead(chat: string) {
    if (!this.chats.find(c => c.id === chat)?.unread) return
    void this.api.messaging.privateMatchRead?.(chat).then(() => this.sync(), () => {})
  }

  private countUnread() {
    this.unread = Object.fromEntries(this.chats.filter(c => c.unread).map(c => [c.id, c.unread]))
  }

  async send(chat: string, text: string) {
    if (this.busy) return false
    this.busy = true
    this.error = ''
    try { await this.api.messaging.privateMatchSend?.(chat, text); return true }
    catch (e) { this.error = e instanceof Error ? e.message : 'Could not send this message.'; return false }
    finally { this.busy = false; this.sync() }
  }

  open() {
    const v = this.api.messaging.privateMatchView()
    if (!v) return
    this.helperView = !Object.keys(v.interests).length && !!Object.keys(v.received).length
    this.dialogOpen = true
    this.sync()
  }

  async act(action: MatchAction, listing?: unknown) {
    if (this.busy) return false
    this.busy = true
    this.error = this.settingsError = ''
    try { await this.api.messaging.privateMatch(action, listing); return true }
    catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save this change.'
      if (this.dialogOpen) this.error = message
      else this.settingsError = message
      return false
    } finally { this.busy = false; this.sync() }
  }
}
