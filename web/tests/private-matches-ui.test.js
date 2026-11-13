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

function mountMatches({view, chats, calls = [], sent = []}) {
  document.body.replaceChildren()
  globalThis.localStorage?.clear()
  const helper = 'a'.repeat(64)
  const messages = document.createElement('div')
  messages.innerHTML = '<div class="chat-shell"></div>'
  document.body.append(messages)
  const opened = []
  const listeners = []
  const api = {
    state: () => ({ownerPubkey: helper, status: 'ready', canSend: true, conversations: []}),
    onState(listener) { listeners.push(listener) }, openChat(key) { opened.push(key) },
    messaging: {privateMatchView: () => structuredClone(view()), privateMatch: async action => { calls.push(action) },
      privateMatchChats: () => structuredClone(chats()), privateMatchSend: async (chat, text) => { sent.push([chat, text]) }},
  }
  setupPrivateMatches(api, () => [], messages)
  return {messages, opened, update: () => listeners.forEach(l => l())}
}
const button = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text))
const hello = {id: 'm1', text: 'Hi! Our helper introduced us privately.', mine: false, created_at: 1, created_at_ms: 1000, delivery: 'received'}

test('an introduced match opens a labeled alias chat inside the dialog', async () => {
  const at = Math.floor(Date.now() / 1000) + 86400
  const view = {sent: {}, received: {}, pairs: {}, public_leads: {},
    interests: {p2: {helper: 'a'.repeat(64), entry: 's2', summary: 'Two-seat cargo bike', expires_at: at, vote: true, contact: null,
      chat: 'match:p2', connected: true, shared_profile: false, revealed: null}}}
  let chats = [{id: 'match:p2', title: 'Two-seat cargo bike', connected: true, shared: false, revealed: null, messages: [hello]}]
  const sent = [], calls = []
  const {messages, opened, update} = mountMatches({view: () => view, chats: () => chats, sent, calls})
  await settle()
  // A new message is visible before the dialog is opened.
  assert.match(messages.querySelector('.match-inbox-link').textContent, /Private matches\s*1/)
  messages.querySelector('.match-inbox-link').click()
  await settle()
  const dialog = document.querySelector('dialog.match-dialog')
  assert.match(dialog.textContent, /Possible match from your helper/)
  assert.match(dialog.textContent, /Introduced\. You can chat privately\./)
  button(dialog, 'Open private chat').click()
  await settle()
  assert.deepEqual(opened, [], 'never opens a chat with an account')
  assert.doesNotMatch(messages.querySelector('.match-inbox-link').textContent, /1/, 'opening the chat marks it read')
  const thread = dialog.querySelector('.match-chat')
  assert.match(thread.textContent, /You appear as a private alias\. They can’t see your profile\./)
  assert.match(thread.textContent, /introduced us privately/)
  const box = thread.querySelector('textarea')
  box.value = 'Is it still available?'
  box.dispatchEvent(new box.ownerDocument.defaultView.Event('input', {bubbles: true}))
  await settle()
  button(thread, 'Send').click()
  await settle()
  assert.deepEqual(sent, [['match:p2', 'Is it still available?']])

  // Sharing a profile takes two deliberate steps and can be cancelled.
  button(thread, 'Share my profile').click()
  await settle()
  assert.match(thread.textContent, /This can’t be undone/)
  button(thread, 'Cancel').click()
  await settle()
  assert.deepEqual(calls, [])
  button(thread, 'Share my profile').click()
  await settle()
  button(thread, 'Share profile').click()
  await settle()
  assert.deepEqual(calls, [{op: 'reveal', proposal: 'p2'}])

  chats = [{...chats[0], shared: true, revealed: 'b'.repeat(64),
    messages: [hello, {id: 'm2', text: 'Shared their profile', mine: false, created_at: 2, created_at_ms: 2000, delivery: 'received'}]}]
  update()
  await settle()
  assert.match(thread.textContent, /You shared your profile in this chat\./)
  assert.match(thread.textContent, /They shared their profile:/)
  assert.ok(button(thread, 'View profile'))
  assert.equal(button(thread, 'Share my profile'), undefined)
})

test('a match that is still connecting explains why it cannot send yet', async () => {
  const at = Math.floor(Date.now() / 1000) + 86400
  const view = {sent: {}, received: {}, pairs: {}, public_leads: {},
    interests: {p3: {helper: 'a'.repeat(64), entry: 's3', summary: 'Garden table', expires_at: at, vote: true, contact: null,
      chat: 'match:p3', connected: false, shared_profile: false, revealed: null}}}
  const chats = [{id: 'match:p3', title: 'Garden table', connected: false, shared: false, revealed: null, messages: []}]
  const {messages} = mountMatches({view: () => view, chats: () => chats})
  await settle()
  messages.querySelector('.match-inbox-link').click()
  await settle()
  const dialog = document.querySelector('dialog.match-dialog')
  assert.match(dialog.textContent, /Introduced\. Connecting privately…/)
  button(dialog, 'Open private chat').click()
  await settle()
  const thread = dialog.querySelector('.match-chat')
  assert.match(thread.textContent, /Connecting privately/)
  assert.equal(thread.querySelector('textarea'), null)
  assert.equal(button(thread, 'Share my profile'), undefined)
})

test('helpers see what an introduction shares and what it does not', async () => {
  const at = Math.floor(Date.now() / 1000) + 86400
  const row = (id, side, summary, peer) => ({id, side, summary, peer, expires_at: at})
  let pair = {entries: ['r1', 'r2'], votes: [true, true], expires_at: at, introduced: false}
  const view = () => ({sent: {}, interests: {}, public_leads: {}, pairs: {x: pair},
    received: {r1: row('r1', 'request', 'Looking for a bike', 'c'.repeat(64)), r2: row('r2', 'offer', 'Bike for sale', 'd'.repeat(64))}})
  const calls = []
  const {messages, update} = mountMatches({view, chats: () => [], calls})
  await settle()
  messages.querySelector('.match-inbox-link').click()
  await settle()
  const dialog = document.querySelector('dialog.match-dialog')
  button(dialog, 'Helping').click()
  await settle()
  assert.match(dialog.textContent, /Introducing them shares a private alias for each, not their profiles/)
  button(dialog, 'Introduce privately').click()
  await settle()
  assert.deepEqual(calls, [{op: 'introduce', proposal: 'x'}])
  pair = {...pair, introduced: true}
  update()
  await settle()
  assert.match(dialog.textContent, /you can’t see their messages/)
})
