// Install before Transformers captures fetch. The native host serves only these
// verified files and the packaged runtime; it disables outbound WebView loads.
import { FEED_MODELS } from '../../web/src/feed-filter/models.ts'

const { repo, revision } = FEED_MODELS.deberta
const root = 'https://huggingface.co/' + repo + '/resolve/' + revision + '/'
const names = new Set(['onnx/model_quantized.onnx', 'config.json', 'tokenizer.json', 'tokenizer_config.json'])
const nativeFetch = self.fetch.bind(self)
self.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), self.location.href)
  if (url.origin === self.location.origin) return nativeFetch(input, init)
  const path = url.href.slice(root.length)
  if (!url.href.startsWith(root) || !names.has(path)) throw Error('Unknown model resource.')
  const request = new Request(input, init)
  if (request.method !== 'GET') throw Error('Unsupported model request.')
  return nativeFetch('/' + path.split('/').pop(), { headers: request.headers, signal: request.signal })
}
