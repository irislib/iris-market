// Drives the web alias implementation over JSON lines so Rust tests can check
// interoperability with crates/market-core/src/messaging/match_chats.rs.
import {createInterface} from 'node:readline'
import {generateSecretKey} from 'nostr-tools'
import * as aliases from '../../src/private-match/aliases.ts'

const device = generateSecretKey(), chat = 'interop'
let alias
const reply = value => process.stdout.write(JSON.stringify(value) + '\n')
for await (const line of createInterface({input: process.stdin})) {
  try {
    const q = JSON.parse(line)
    if (q.op === 'create') {
      const made = aliases.createAlias(device, q.title, q.expires_at, [])
      alias = made.alias
      reply({pubkey: alias.pubkey, url: made.url})
    } else if (q.op === 'introduced') {
      const jobs = await aliases.introduced(device, alias, chat, q.peer, q.url)
      reply({events: jobs.map(j => j.event)})
    } else if (q.op === 'deliver') {
      if (q.event.kind === 1059) await aliases.respond(device, alias, q.event)
      else aliases.receive(alias, q.event)
      reply({connected: aliases.canSend(alias), texts: alias.messages.map(m => m.text)})
    } else if (q.op === 'send') {
      reply({events: [aliases.send(alias, chat, q.text).event]})
    } else reply({error: 'unknown op'})
  } catch (error) { reply({error: String(error?.message ?? error)}) }
}
