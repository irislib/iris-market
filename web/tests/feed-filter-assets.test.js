import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { pinnedModelAsset, createPinnedModelFetch } from '../src/feed-filter/assets.ts'
import { FEED_MODELS } from '../src/feed-filter/models.ts'
import { RUNTIME, verifyRuntimeResponse } from '../src/feed-filter/runtime.ts'
const model = FEED_MODELS.deberta
const pinned = `https://huggingface.co/${model.repo}/resolve/${model.revision}`
const range = { headers: { Range: 'bytes=0-0' } }

test('v4 tokenizer metadata probe is rewritten to the immutable revision before fetch', async () => {
  const actual = [], fetcher = createPinnedModelFetch(async (url, init) => {
    actual.push([String(url), new Headers(init.headers).get('range')])
    return new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/1200' } })
  })
  await fetcher(`https://huggingface.co/${model.repo}/resolve/main/tokenizer_config.json`, range)
  assert.deepEqual(actual, [[`${pinned}/tokenizer_config.json`, 'bytes=0-0']])
  assert.equal(pinnedModelAsset(`${pinned}/tokenizer.json`).request, `${pinned}/tokenizer.json`)
})

test('offline tokenizer probe reads only the exact pinned cache key before any network request', async () => {
  const lookups = []
  const fetcher = createPinnedModelFetch(async () => { throw new Error('Network is disabled') }, {
    readCache: async request => {
      lookups.push(request instanceof Request ? request.url : String(request))
      return new Response('{"tokenizer_class":"DebertaV2Tokenizer"}', { headers: { 'content-type': 'application/json' } })
    },
  })
  const request = new Request(`https://huggingface.co/${model.repo}/resolve/main/tokenizer_config.json`, range)
  assert.equal((await (await fetcher(request)).json()).tokenizer_class, 'DebertaV2Tokenizer')
  assert.deepEqual(lookups, [`${pinned}/tokenizer_config.json`])
  await assert.rejects(fetcher(`https://huggingface.co/${model.repo}/resolve/main/tokenizer_config.json`), /unpinned/)
  await assert.rejects(fetcher(`${pinned.replace(model.revision, '0'.repeat(40))}/tokenizer_config.json`, range), /unpinned/)
  assert.equal(lookups.length, 1)
})

test('missing, partial or unavailable metadata cache uses only the pinned network URL', async () => {
  const requests = []
  for (const readCache of [async () => undefined, async () => new Response('x', { status: 206 }), async () => { throw new Error('Cache unavailable') }]) {
    const fetcher = createPinnedModelFetch(async request => {
      requests.push(String(request))
      return new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/100' } })
    }, { readCache })
    assert.equal((await fetcher(`https://huggingface.co/${model.repo}/resolve/main/tokenizer_config.json`, range)).status, 206)
  }
  assert.deepEqual(requests, Array(3).fill(`${pinned}/tokenizer_config.json`))
})

test('the metadata cache adapter cannot serve or bypass integrity checks for model weights', async () => {
  let lookups = 0
  const fetcher = createPinnedModelFetch(async () => new Response('corrupt weight'), {
    readCache: async () => { lookups++; return new Response('unverified cache data') },
  })
  await assert.rejects(fetcher(`${pinned}/onnx/model_quantized.onnx`), /integrity/)
  assert.equal(lookups, 0)
})

test('mutable full downloads, other assets, repositories and protocols remain blocked', () => {
  for (const [url, init] of [
    [`https://huggingface.co/${model.repo}/resolve/main/tokenizer_config.json`, undefined],
    [`https://huggingface.co/${model.repo}/resolve/main/config.json`, range],
    [`https://huggingface.co/${model.repo}/resolve/main/onnx/model_quantized.onnx`, range],
    [`${pinned}/onnx/model_unknown.onnx_data_0`, undefined],
    ['https://huggingface.co/other/model/resolve/main/config.json', range],
    [pinned.replace('https:', 'http:') + '/config.json', undefined],
    ['https://cdn.example/runtime.wasm', undefined],
  ]) assert.throws(() => pinnedModelAsset(url, init), /unpinned/)
})

test('complete weight downloads still require their exact SHA256; partial bytes cannot become weights', async () => {
  const body = new TextEncoder().encode('fixture weight bytes')
  const models = { fixture: { ...model, files: { 'model_quantized.onnx': createHash('sha256').update(body).digest('hex') } } }
  let response = () => new Response(body)
  const fetcher = createPinnedModelFetch(async () => response(), { models })
  const url = `${pinned}/onnx/model_quantized.onnx`
  assert.deepEqual(new Uint8Array(await (await fetcher(url)).arrayBuffer()), body)
  response = () => new Response('corrupt')
  await assert.rejects(fetcher(url), /integrity/)
  response = () => new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/20' } })
  await assert.rejects(fetcher(url), /partial/)
  assert.equal((await fetcher(url, range)).status, 206)
})

test('gzip runtime is size-bounded and checked against the pinned unpacked digest', async () => {
  const binary = new TextEncoder().encode('small wasm fixture')
  const compressed = gzipSync(binary)
  const spec = { byteLength: binary.length, sha256: createHash('sha256').update(binary).digest('hex'), maxCompressedBytes: compressed.length }
  assert.deepEqual(await verifyRuntimeResponse(new Response(compressed), spec), binary)
  await assert.rejects(verifyRuntimeResponse(new Response(compressed), { ...spec, sha256: '0'.repeat(64) }), /integrity/)
  await assert.rejects(verifyRuntimeResponse(new Response(compressed), { ...spec, byteLength: binary.length - 1 }), /pinned size/)
  await assert.rejects(verifyRuntimeResponse(new Response(compressed), { ...spec, maxCompressedBytes: compressed.length - 1 }), /pinned size/)
  assert.equal(RUNTIME.byteLength, 26861777)
  assert.equal(RUNTIME.sha256, '49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082')
})

test('weight download streams real byte progress and verifies the complete payload',async()=>{
  const chunks=[new TextEncoder().encode('first'),new TextEncoder().encode('second')],bytes=Buffer.concat(chunks),progress=[];
  const models={fixture:{...model,files:{'model_quantized.onnx':createHash('sha256').update(bytes).digest('hex')}}};
  const response=()=>new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}}),{headers:{'content-length':String(bytes.length)}});
  const fetcher=createPinnedModelFetch(async()=>response(),{models,onProgress:(message,detail)=>progress.push({message,detail})});
  assert.deepEqual(new Uint8Array(await(await fetcher(`${pinned}/onnx/model_quantized.onnx`)).arrayBuffer()),new Uint8Array(bytes));
  assert(progress.some(item=>item.detail?.loaded===5&&item.detail.total===11));
  assert(progress.some(item=>item.detail?.loaded===11&&item.message.includes('100%')));
  assert.equal(progress.at(-1).message,'Verifying model download…');
});
