import type { ProgressHandler, FeedModelSpec } from './types.ts'
/*! Model integrity handling adapted from Iris client's feed-filter pilot (MIT, Copyright 2024 Martti Malmi). License: ./LICENSE. */
import { FEED_MODELS } from './models.ts'

/** v4's tokenizer existence probe omits revision. Rewrite only that exact probe. */
export function pinnedModelAsset(input: RequestInfo | URL, init?: RequestInit, models: Readonly<Record<string, FeedModelSpec>> = FEED_MODELS) {
  const isRequest = input instanceof Request
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase()
  const headers = new Headers(isRequest ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  const metadataOnly = method === 'GET' && headers.get('range') === 'bytes=0-0'
  if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' || url.port || url.username || url.password || url.hash || method !== 'GET') {
    throw new Error('The model requested an unpinned download.')
  }
  const known = Object.values(models)
  const probe = known.find(model => url.pathname === `/${model.repo}/resolve/main/tokenizer_config.json`)
  if (probe && metadataOnly) url.pathname = `/${probe.repo}/resolve/${probe.revision}/tokenizer_config.json`
  const spec = known.find(model => url.pathname.startsWith(`/${model.repo}/resolve/${model.revision}/`))
  if (!spec) throw new Error('The model requested an unpinned download.')
  const name = url.pathname.split('/').at(-1)
  const expected = spec.files[name]
  if (name.includes('.onnx') && !expected) throw new Error('The model requested an unpinned weight file.')
  return { request: isRequest ? new Request(url.href, input) : url.href, spec, expected, metadataOnly }
}

export function createPinnedModelFetch(fetchImpl: typeof fetch, { onProgress = () => {}, models = FEED_MODELS }: { onProgress?: ProgressHandler; models?: Readonly<Record<string, FeedModelSpec>> } = {}): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const { request, spec, expected, metadataOnly } = pinnedModelAsset(input, init, models)
    const response = await fetchImpl(request, init)
    if (!response.ok || !expected) return response
    const maxBytes = Math.ceil(spec.downloadMB * 1.15) * 1000000
    // Range probes inspect metadata only. They are never model bytes or cache entries.
    if (response.status === 206) {
      const range = response.headers.get('content-range')?.match(/^bytes 0-0\/(\d+)$/)
      if (!metadataOnly || !range || Number(range[1]) > maxBytes) throw new Error('Unexpected partial model response.')
      return response
    }
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('The model download exceeds its expected size.')
    onProgress(`Downloading ${spec.label}…`)
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > maxBytes) throw new Error('The model download exceeds its expected size.')
    onProgress('Verifying model download…')
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    if (actual !== expected) throw new Error('Model download failed its integrity check.')
    return new Response(bytes, { status: response.status, headers: response.headers })
  }
}
