// npm ci --ignore-scripts, then node scripts/generate-graph-bootstrap.mjs /path/to/social-graph.bin
// Input is the exact public asset pinned below. No network or sibling checkout is required.
import {readFile, writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {SocialGraph} from 'nostr-social-graph'
import {projectSocialGraph} from './project-social-graph.ts'

const provenance = JSON.parse(await readFile(new URL('../src/data/social-graph.provenance.json', import.meta.url)))
const installed = JSON.parse(await readFile(new URL('../node_modules/nostr-social-graph/package.json', import.meta.url)))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
if (`${installed.name}@${installed.version}` !== provenance.projection.library) throw Error('Graph library version differs from the reviewed recipe')
if (!process.argv[2]) throw Error('Provide the pinned public social-graph.bin input file')
const input = await readFile(process.argv[2])
if (input.byteLength !== provenance.source.byteLength || digest(input) !== provenance.source.sha256) throw Error('Source snapshot integrity check failed')
const graph = await SocialGraph.fromBinary(provenance.root, new Uint8Array(input))
const limits = provenance.projection
if (digest(await readFile(new URL('./project-social-graph.ts', import.meta.url))) !== limits.recipeSha256) throw Error('Projection recipe differs from reviewed source')
const canonical = await projectSocialGraph(graph, provenance.root, limits.ownerDistance)
const bytes = await canonical.toBinary()
if (bytes.byteLength !== limits.byteLength || digest(bytes) !== limits.sha256) throw Error('Projection differs from the reviewed snapshot')
await writeFile(new URL('../src/data/social-graph.bin', import.meta.url), bytes)
console.log(`Verified company graph: ${bytes.byteLength} bytes, ${digest(bytes)}`)
