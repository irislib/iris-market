// Pipe public kind-30402 events (one JSON object per line) to this offline step.
// Sample each relay with: nak req --paginate -k 30402 -l 16000 wss://RELAY
// The shipped snapshot used Ditto, Primal, Iris Vault and Damus on 2026-11-03.
// Only exact tag spellings enter the output. Listings must still be fetched and verified at runtime.
import { createInterface } from 'node:readline'
import { parseEvent } from '../src/market.ts'

const cells = new Set()
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    const event = JSON.parse(line)
    if (event.kind !== 30402 || !event.tags?.some(tag => tag[0] === 'g')) continue
    const listing = parseEvent(event)
    for (const [name, value, role] of listing.originalTags) {
      if (name === 'g' && role !== 'pickup' && role !== 'destination' && value?.toLowerCase() === listing.geohash) cells.add(value)
    }
  } catch { /* Ignore malformed or unsigned input. */ }
}
if (cells.size > 4096) throw new Error('Partition the map catalog before increasing the viewport budget.')
if (!cells.size) throw new Error('No verified public map cells in input.')
console.log(JSON.stringify([...cells].sort(), null, 2))
