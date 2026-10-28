import { assetUrl } from './asset-url.js'
import { SocialGraph } from 'nostr-social-graph'

// The installed release tarball is integrity-pinned in package-lock.json. The
// separate digest below also pins the exact public snapshot shipped to browsers.
export const GRAPH_BOOTSTRAP = Object.freeze({
  root: '4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0',
  url: './social-graph.bin',
  package: 'nostr-social-graph@2.0.4',
  packagePath: 'node_modules/nostr-social-graph/data/socialGraph.bin',
  byteLength: 1_182_110,
  sha256: '6d6ce09dfcc587e4de377a40ced50221568d674705d7e909182390e8edd58d1c',
  maxUsers: 25_000,
  maxEdges: 150_000,
})

function checkRoot(root) {
  // Binary graphs do not encode a root: fromBinary accepts one from the caller.
  // Bind this particular discovery snapshot to its reviewed public root.
  if (root !== GRAPH_BOOTSTRAP.root) throw new Error('This saved network belongs to a different profile.')
}
function active(signal) { signal?.throwIfAborted() }

/** This snapshot contains no event signatures. Never use it for trust badges. */
export async function decodeGraphBootstrap(input, { root = GRAPH_BOOTSTRAP.root, signal } = {}) {
  checkRoot(root); active(signal)
  if (!(input instanceof Uint8Array) || input.byteLength !== GRAPH_BOOTSTRAP.byteLength) throw new Error('Invalid saved network size.')
  const bytes = input.slice()
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  if (Array.from(digest, value => value.toString(16).padStart(2, '0')).join('') !== GRAPH_BOOTSTRAP.sha256) throw new Error('Saved network integrity check failed.')
  active(signal)
  const graph = await SocialGraph.fromBinary(root, bytes)
  active(signal)
  const size = graph.size()
  if (graph.getRoot() !== root || size.users > GRAPH_BOOTSTRAP.maxUsers || size.follows + size.mutes > GRAPH_BOOTSTRAP.maxEdges) throw new Error('Saved network exceeds its supported limits.')
  let newestFollowAt = 0
  for (const timestamp of graph.getInternalData().followListCreatedAt.values()) newestFollowAt = Math.max(newestFollowAt, timestamp)
  return { graph, provenance: Object.freeze({
    source: 'bundled-snapshot', package: GRAPH_BOOTSTRAP.package, root,
    sha256: GRAPH_BOOTSTRAP.sha256, bytes: bytes.byteLength,
    verifiedEvents: false, stale: true, newestFollowAt,
  }) }
}

async function responseBytes(response, signal) {
  if (!response.ok) throw new Error('Could not load the saved network.')
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > GRAPH_BOOTSTRAP.byteLength)) throw new Error('Saved network response is too large.')
  if (!response.body) throw new Error('Saved network response is empty.')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    for (;;) {
      active(signal)
      const { value, done } = await reader.read()
      active(signal)
      if (done) break
      size += value.byteLength
      if (size > GRAPH_BOOTSTRAP.byteLength) throw new Error('Saved network response is too large.')
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

/** Loads only a pinned same-origin asset; there is no mutable graph-server fallback. */
export async function loadGraphBootstrap({ root = GRAPH_BOOTSTRAP.root, signal, fetchImpl = globalThis.fetch, timeoutMs = 8000, baseURI } = {}) {
  checkRoot(root); active(signal)
  if (typeof fetchImpl !== 'function') throw new Error('Saved network loading is unavailable.')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid saved network timeout.')
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new DOMException('Saved network loading timed out.', 'TimeoutError')), timeoutMs)
  try {
    active(signal)
    const response = await fetchImpl.call(globalThis, assetUrl(GRAPH_BOOTSTRAP.url, baseURI), { credentials: 'omit', redirect: 'error', cache: 'force-cache', signal: controller.signal })
    const bytes = await responseBytes(response, controller.signal)
    return await decodeGraphBootstrap(bytes, { root, signal: controller.signal })
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
}
