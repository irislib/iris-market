import {mount} from 'svelte'
import Dialog from './private-match/Dialog.svelte'
import InboxLink from './private-match/InboxLink.svelte'
import Settings from './private-match/Settings.svelte'
import {PrivateMatchState, type PrivateMatchApi} from './private-match/state.svelte.ts'

export function setupPrivateMatches(api: PrivateMatchApi, getListings: () => any[], messages: HTMLElement) {
  const matches = new PrivateMatchState(api)
  const settings = document.querySelector('#preferences-dialog')
  if (settings) mount(Settings, {target: settings, props: {matches}})
  const shell = messages.querySelector('.chat-shell')
  if (shell?.parentElement) mount(InboxLink, {target: shell.parentElement, anchor: shell, props: {matches}})
  mount(Dialog, {target: document.body, props: {matches, getListings}})
  api.onState(() => matches.sync())
  matches.sync()
}
