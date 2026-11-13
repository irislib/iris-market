import test from 'node:test'
import assert from 'node:assert/strict'
import {settle} from './support/dom.mjs'

const {setupPrivateMatches} = await import('../src/private-match-ui.ts')

test('private matches dialog lists offers and sends votes through the account', async () => {
  const at = Math.floor(Date.now() / 1000) + 86400
  const helper = 'a'.repeat(64)
  const view = {sent: {}, received: {}, pairs: {}, public_leads: {},
    interests: {p1: {helper, entry: 's1', summary: 'Cargo bike, Helsinki', expires_at: at, vote: null, contact: null}}}
  const calls = []
  const messages = document.createElement('div')
  messages.innerHTML = '<div class="chat-shell"></div>'
  document.body.append(messages)
  setupPrivateMatches({
    state: () => ({ownerPubkey: helper, status: 'ready', canSend: true, conversations: []}),
    onState() {}, openChat() {},
    messaging: {privateMatchView: () => structuredClone(view), privateMatch: async action => { calls.push(action) }},
  }, () => [], messages)
  await settle()
  const link = messages.querySelector('.match-inbox-link')
  assert.equal(link.hidden, false)
  link.click()
  await settle()
  const dialog = document.querySelector('dialog.match-dialog')
  assert.match(dialog.textContent, /Cargo bike, Helsinki/)
  ;[...dialog.querySelectorAll('button')].find(b => b.textContent === 'Agree to introduction').click()
  await settle()
  assert.deepEqual(calls, [{op: 'vote', proposal: 'p1', accept: true}])
})

test('an introduced match opens a labeled alias chat inside the dialog', async () => {
  document.body.replaceChildren()
  const at = Math.floor(Date.now() / 1000) + 86400
  const helper = 'a'.repeat(64)
  const view = {sent: {}, received: {}, pairs: {}, public_leads: {},
    interests: {p2: {helper, entry: 's2', summary: 'Two-seat cargo bike', expires_at: at, vote: true, contact: null, chat: 'match:p2'}}}
  const chats = [{id: 'match:p2', title: 'Two-seat cargo bike', connected: true,
    messages: [{id: 'm1', text: 'Hi! Our helper introduced us privately.', mine: false, created_at: 1, created_at_ms: 1000, delivery: 'received'}]}]
  const sent = [], opened = []
  const messages = document.createElement('div')
  messages.innerHTML = '<div class="chat-shell"></div>'
  document.body.append(messages)
  setupPrivateMatches({
    state: () => ({ownerPubkey: helper, status: 'ready', canSend: true, conversations: []}),
    onState() {}, openChat(key) { opened.push(key) },
    messaging: {privateMatchView: () => structuredClone(view), privateMatch: async () => {},
      privateMatchChats: () => structuredClone(chats), privateMatchSend: async (chat, text) => { sent.push([chat, text]) }},
  }, () => [], messages)
  await settle()
  messages.querySelector('.match-inbox-link').click()
  await settle()
  const dialog = document.querySelector('dialog.match-dialog')
  assert.match(dialog.textContent, /You have been introduced/)
  ;[...dialog.querySelectorAll('button')].find(b => b.textContent === 'Open private chat').click()
  await settle()
  assert.deepEqual(opened, [], 'never opens a chat with an account')
  const thread = dialog.querySelector('.match-chat')
  assert.match(thread.textContent, /Via private match/)
  assert.match(thread.textContent, /introduced us privately/)
  const box = thread.querySelector('textarea')
  box.value = 'Is it still available?'
  box.dispatchEvent(new box.ownerDocument.defaultView.Event('input', {bubbles: true}))
  await settle()
  ;[...thread.querySelectorAll('button')].find(b => b.textContent === 'Send').click()
  await settle()
  assert.deepEqual(sent, [['match:p2', 'Is it still available?']])
})
