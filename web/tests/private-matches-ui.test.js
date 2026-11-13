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
