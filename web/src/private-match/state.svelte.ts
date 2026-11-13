import type {MatchAction, MatchView} from '../private-matches.ts'

export type PrivateMatchApi = {
  state(): {ownerPubkey?: string; status: string; canSend?: boolean; conversations: {pubkey: string}[]}
  onState(listener: () => void): unknown
  openChat(pubkey: string): unknown
  messaging: {
    privateMatchView(): MatchView | null
    privateMatch(action: MatchAction, listing?: unknown): Promise<void>
  }
}

// Shared by the settings toggle, the Messages link and the dialog.
export class PrivateMatchState {
  view = $state.raw<MatchView | null>(null)
  owner = $state('')
  ready = $state(false)
  canSend = $state(false)
  peers = $state.raw<string[]>([])
  dialogOpen = $state(false)
  helperView = $state(false)
  error = $state('')
  settingsError = $state('')
  busy = false

  constructor(readonly api: PrivateMatchApi) {}

  sync() {
    const state = this.api.state()
    const owner = state.ownerPubkey ?? ''
    if (this.owner !== owner) this.dialogOpen = false
    this.owner = owner
    this.ready = state.status === 'ready'
    this.canSend = !!state.canSend
    this.peers = state.conversations.map(c => c.pubkey)
    this.view = this.api.messaging.privateMatchView()
    if (!this.view) this.dialogOpen = false
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
