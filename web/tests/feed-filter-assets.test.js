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
