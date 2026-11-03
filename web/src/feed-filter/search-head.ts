// Generated from the two pinned ONNX files by web/scripts/pack-search-head.py.
// Original logits occupy columns 0..2; column 3 is the trained entailment logit.
import patch from './search-head.json' with {type:'json'}
import {FEED_MODELS} from './models.ts'

const spec = FEED_MODELS.deberta
export const SEARCH_MODEL_FILE = 'market_' + patch.sha256
const directory = `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/onnx/`
const baseUrl = directory + 'model_quantized.onnx'
const modelUrl = directory + SEARCH_MODEL_FILE + '_quantized.onnx'

export async function addSearchHead(base: Uint8Array) {
  const output = new Uint8Array(patch.size)
  let source = 0, dest = 0
  for (const [start, end, encoded] of patch.edits as [number, number, string][]) {
    output.set(base.subarray(source, start), dest)
    dest += start - source
    const replacement = Uint8Array.from(atob(encoded), c => c.charCodeAt(0))
    output.set(replacement, dest)
    dest += replacement.length
    source = end
  }
  output.set(base.subarray(source), dest)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', output))
  if (Array.from(hash, b => b.toString(16).padStart(2, '0')).join('') !== patch.sha256)
    throw Error('The marketplace model failed its integrity check.')
  return output
}

/** Only the exact, content-versioned virtual file is synthesized. All actual
 * network requests continue through the upstream revision and hash checks. */
export function withSearchHead(fetchPinned: typeof fetch, readBase: (url:string)=>Promise<Response|undefined>): typeof fetch {
  return async (input,init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== modelUrl) return fetchPinned(input,init)
    const request = new Request(input,init)
    if (request.method !== 'GET') throw Error('Unsupported model request.')
    if (request.headers.has('range')) {
      if (request.headers.get('range') !== 'bytes=0-0') throw Error('Unsupported model range.')
      // The local virtual file has a known size and protobuf first byte.
      return new Response(Uint8Array.of(8), {status:206,headers:{'content-range':`bytes 0-0/${patch.size}`}})
    }
    const cached = await readBase(baseUrl).catch(()=>undefined)
    const response = cached?.status === 200 ? cached : await fetchPinned(baseUrl,{signal:request.signal})
    if (!response.ok) return response
    const output = await addSearchHead(new Uint8Array(await response.arrayBuffer()))
    return new Response(output,{headers:{'content-length':String(output.length),'content-type':'application/octet-stream'}})
  }
}
