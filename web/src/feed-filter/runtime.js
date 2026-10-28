import { assetUrl } from '../asset-url.js'
// Payload from pinned onnxruntime-web 1.31.0-dev.20260914-8d85527a0.
// Gzip keeps the static deployment below its per-file limit; verify unpacked bytes.
export const RUNTIME = Object.freeze({
  wasm: 'ort-wasm-simd-threaded.asyncify.wasm.gz',
  mjs: 'ort-wasm-simd-threaded.asyncify.mjs',
  byteLength: 26861777,
  sha256: '49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082',
  maxCompressedBytes: 12000000,
})

async function readLimited(stream, maximum) {
  const reader = stream.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) throw new Error('The local runtime exceeds its pinned size.')
      chunks.push(value)
    }
  } catch (error) { try { await reader.cancel() } catch {} throw error }
  finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

export async function verifyRuntimeResponse(response, spec = RUNTIME) {
  if (!response.ok || !response.body) throw new Error('Could not download the local runtime.')
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot unpack the local runtime.')
  const compressed = await readLimited(response.body, spec.maxCompressedBytes)
  const stream = new Response(compressed).body.pipeThrough(new DecompressionStream('gzip'))
  const binary = await readLimited(stream, spec.byteLength)
  if (binary.byteLength !== spec.byteLength) throw new Error('The local runtime has an unexpected size.')
  const digest = await crypto.subtle.digest('SHA-256', binary)
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== spec.sha256) throw new Error('The local runtime failed its integrity check.')
  return binary
}

export async function loadRuntimeBinary(onProgress = () => {}, { baseURI, fetchImpl = globalThis.fetch } = {}) {
  onProgress('Loading local runtime…')
  const response = await fetchImpl(assetUrl(RUNTIME.wasm, baseURI))
  return verifyRuntimeResponse(response)
}
