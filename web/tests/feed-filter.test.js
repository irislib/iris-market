import test from 'node:test'
import assert from 'node:assert/strict'
import { FeedFilterClient, FEED_MODELS, DEFAULT_FEED_MODEL } from '../src/feed-filter/client.ts'
import { validateModel } from '../src/feed-filter/models.ts'

class FakeWorker {
  static instances = []
  constructor(url, options) { this.url = url; this.options = options; this.messages = []; this.terminated = false; FakeWorker.instances.push(this) }
  postMessage(data) { this.messages.push(data) }
  respond(result) { this.onmessage?.({ data: { id: this.messages.at(-1).id, result } }) }
  fail(error) { this.onmessage?.({ data: { id: this.messages.at(-1).id, error } }) }
  terminate() { this.terminated = true }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const make = () => { FakeWorker.instances = []; return new FeedFilterClient({ WorkerImpl: FakeWorker }) }
async function load(client, model = 'deberta') {
  const pending = client.load(model, model === 'deberta' ? 'wasm' : 'webgpu'); await tick()
  const worker = FakeWorker.instances.at(-1)
  worker.respond({ device: model === 'deberta' ? 'wasm' : 'webgpu', loadMilliseconds: 12 }); await pending
  return worker
}

test('CPU filtering is the default while both pinned models remain available for diagnostics', () => {
  assert.equal(DEFAULT_FEED_MODEL, 'deberta')
  assert.equal(FEED_MODELS[DEFAULT_FEED_MODEL].requiresWebGPU, false)
  assert.doesNotThrow(() => validateModel(DEFAULT_FEED_MODEL, 'wasm'))
  assert.deepEqual(Object.keys(FEED_MODELS).sort(), ['deberta', 'qwen35'])
  for (const spec of Object.values(FEED_MODELS)) {
    assert.match(spec.revision, /^[0-9a-f]{40}$/)
    for (const hash of Object.values(spec.files)) assert.match(hash, /^[0-9a-f]{64}$/)
  }
  assert.throws(() => validateModel('qwen35', 'wasm'), /WebGPU/)
  assert.throws(() => validateModel('lfm', 'auto'), /supported/)
})

test('constructing or classifying before explicit load starts no worker or download', async () => {
  const client = make()
  await assert.rejects(client.classify('a chair', 'oak chair'), /Load a local model/)
  await assert.rejects(client.load('lfm'), /supported/)
  assert.equal(FakeWorker.instances.length, 0)
})

test('explicit load reports progress and classification caches bounded inputs', async () => {
  const client = make(), progress = []
  try {
    const pending = client.load('deberta', 'wasm', message => progress.push(message)); await tick()
    const worker = FakeWorker.instances[0]
    worker.onmessage({ data: { id: 1, progress: 'Loading' } })
    worker.respond({ device: 'wasm' }); await pending
    assert.deepEqual(progress, ['Loading'])
    const classified = client.classify('  a chair  ', 'oak chair'); await tick()
    assert.deepEqual(worker.messages.at(-1), { type: 'classify', condition: 'a chair', content: 'oak chair', id: 2 })
    worker.respond({ score: 0.8, truncated: false }); assert.equal((await classified).show, true)
    assert.equal((await client.classify('a chair', 'oak chair')).cached, true)
    assert.equal(worker.messages.length, 2)
    const long = client.classify('a chair', 'x'.repeat(9000)); await tick()
    assert.equal(worker.messages.at(-1).content.length, 2000)
    worker.respond({ score: 0.1 }); assert.equal((await long).truncated, true)
  } finally { client.dispose() }
})

test('errors never turn into hide decisions and disposal prevents queued work restarting', async () => {
  const client = make(); const worker = await load(client)
  const active = client.classify('chair', 'first'), queued = client.classify('chair', 'second')
  const rejected = Promise.all([assert.rejects(active, /failed/), assert.rejects(queued, /stopped/)])
  await tick(); worker.fail('Inference failed.'); await rejected
  assert(worker.terminated); assert.equal(FakeWorker.instances.length, 1)
  await assert.rejects(client.classify('chair', 'third'), /Load a local model/)
})

test('cache is bounded and changing models clears old decisions', async () => {
  const client = make(); const worker = await load(client)
  try {
    for (let i = 0; i < 257; i++) {
      const pending = client.classify('chair', String(i)); await tick(); worker.respond({ score: 0.7 }); await pending
    }
    const first = client.classify('chair', '0'); await tick()
    assert.equal(worker.messages.at(-1).content, '0'); worker.respond({ score: 0.2 }); assert.equal((await first).cached, false)
    await load(client, 'qwen35')
    const changed = client.classify('chair', '1'); await tick()
    worker.respond({ score: 0 }); assert.equal((await changed).show, false)
  } finally { client.dispose() }
})

test('timeout, cancellation and idle release terminate the worker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = make(); let worker = await load(client)
  let pending = client.classify('chair', 'one'); await tick()
  t.mock.timers.tick(60000); await assert.rejects(pending, /too long/); assert(worker.terminated)
  worker = await load(client)
  const controller = new AbortController()
  pending = client.classify('chair', 'two', { signal: controller.signal }); await tick()
  controller.abort(); await assert.rejects(pending, /cancelled/); assert(worker.terminated)
  worker = await load(client); t.mock.timers.tick(120000); assert(worker.terminated)
  assert.equal(client.info, null)
})
