import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { verifyMobileGraphSnapshot } from 'nostr-social-graph/mobileGraphSnapshot'

const provenance = JSON.parse(await readFile(new URL('../src/data/social-graph.provenance.json', import.meta.url)))
const file = name => new URL(import.meta.resolve('nostr-social-graph/' + name))
const installed = JSON.parse(await readFile(file('package.json')))
if (installed.name + '@' + installed.version !== provenance.source.package) throw Error('Unexpected graph SDK version')

const receiptBytes = await readFile(file('data/socialGraph.json'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
if (sha256(receiptBytes) !== provenance.source.receiptSha256) throw Error('Unexpected signed snapshot receipt')
const receipt = JSON.parse(receiptBytes)
if (receipt.root !== provenance.root || receipt.source.url !== provenance.source.url ||
    receipt.source.eventId !== provenance.source.eventId || receipt.source.directoryHash !== provenance.source.directoryHash) {
  throw Error('Unexpected graph snapshot origin')
}
const source = await readFile(process.argv[2] ?? file('data/socialGraph.bin'))
const graph = await verifyMobileGraphSnapshot(source, receipt)
const { maxNodes, maxEdges, maxDistance, maxEdgesPerNode } = provenance.projection
const bytes = await graph.toBinary(maxNodes, maxEdges, maxDistance, maxEdgesPerNode)
if (bytes.length !== provenance.snapshot.byteLength || bytes.length > 1_100_000 ||
    sha256(bytes) !== provenance.snapshot.sha256) throw Error('Unexpected Market projection')
await writeFile(new URL('../src/data/social-graph.bin', import.meta.url), bytes)
console.log(`Verified Market graph: ${bytes.length} bytes, ${provenance.snapshot.sha256}`)
