// npm ci --ignore-scripts, then node scripts/generate-graph-bootstrap.mjs.
// Copy the reviewed mobile snapshot from the locked SDK, preserving list IDs.
import {readFile, writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {SocialGraph} from 'nostr-social-graph'

const provenance = JSON.parse(await readFile(new URL('../src/data/social-graph.provenance.json', import.meta.url)))
const installed = JSON.parse(await readFile(new URL('../node_modules/nostr-social-graph/package.json', import.meta.url)))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
if (`${installed.name}@${installed.version}` !== provenance.source.package) throw Error('Graph library version differs from the reviewed source')
const input = process.argv[2] ?? new URL('../node_modules/nostr-social-graph/data/socialGraph.bin', import.meta.url)
const bytes = await readFile(input)
if (bytes.byteLength !== provenance.snapshot.byteLength || digest(bytes) !== provenance.snapshot.sha256) throw Error('Source snapshot integrity check failed')
const graph = await SocialGraph.fromBinary(provenance.root, new Uint8Array(bytes))
const size = graph.size()
for (const field of ['users', 'follows', 'mutes']) if (size[field] !== provenance.snapshot[field]) throw Error('Snapshot census differs from reviewed source')
const revisions = [...graph.getInternalData().listRevisions]
for (const kind of [3, 10000]) if (!revisions.some(([key, revision]) => key.startsWith(`${kind}:`) && revision.id)) throw Error('Snapshot is missing list revision IDs')
await writeFile(new URL('../src/data/social-graph.bin', import.meta.url), bytes)
console.log(`Verified company graph: ${bytes.byteLength} bytes, ${digest(bytes)}`)
