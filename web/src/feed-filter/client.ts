import type { FeedModelInfo, ClassificationResult, FeedDecision, FilterRequest, FilterResult, ProgressHandler, WorkerResponse } from './types.ts'
import { assetUrl } from '../asset-url.ts'
/*! Adapted from Iris client's src/lib/feed-filter/client.ts (MIT, Copyright 2024 Martti Malmi).
 * Upstream pilot snapshot SHA256: e25beb76a39d334d1e53159f8fa7abde84fdbc9fd27f3310d4a788018dbce09f.
 * License: ./LICENSE. Explicit loading, bounded caching, and cancellation for Iris Market. */
import { FEED_MODELS, FILTER_VERSION, MAX_LISTING_LENGTH, validateModel, validateInput } from './models.ts'
export { FEED_MODELS, DEFAULT_FEED_MODEL } from './models.ts'

export class FeedFilterClient {
  Worker: typeof Worker
  workerUrl: string
  worker: Worker | null
  info: Readonly<FeedModelInfo> | null
  serial: number
  generation: number
  pending: Map<number, { resolve: (value: FilterResult) => void; reject: (reason?: unknown) => void; progress?: ProgressHandler; timer: ReturnType<typeof setTimeout>; unlisten: () => void }>
  cache: Map<string, Readonly<FeedDecision>>
  queue: Promise<unknown>
  queued: number
  idleTimer: ReturnType<typeof setTimeout> | null
  constructor({ WorkerImpl = globalThis.Worker, workerUrl = assetUrl('feed-filter.worker.js') } = {}) {
    this.Worker = WorkerImpl; this.workerUrl = workerUrl
    this.worker = null; this.info = null; this.serial = 0; this.generation = 0
    this.pending = new Map(); this.cache = new Map(); this.queue = Promise.resolve(); this.queued = 0; this.idleTimer = null
  }
  exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.queued >= 64) return Promise.reject(new Error('Too many listings are waiting for local filtering.'))
    const generation = this.generation
    this.queued++
    const result = this.queue.then(() => {
      if (generation !== this.generation) throw new Error('Local filter stopped.')
      return run()
    }).finally(() => { this.queued-- })
    this.queue = result.catch(() => {})
    return result
  }
  request(data: Extract<FilterRequest, {type: 'load'}>, progress?: ProgressHandler, timeout?: number, signal?: AbortSignal): Promise<FeedModelInfo>
  request(data: Extract<FilterRequest, {type: 'classify'}>, progress?: ProgressHandler, timeout?: number, signal?: AbortSignal): Promise<ClassificationResult>
  request(data: FilterRequest, progress?: ProgressHandler, timeout = 60000, signal?: AbortSignal): Promise<FilterResult> {
    clearTimeout(this.idleTimer)
    if (!this.worker) {
      if (typeof this.Worker !== 'function') throw new Error('Local models need a browser with worker support.')
      const worker = new this.Worker(this.workerUrl, { type: 'module' })
      this.worker = worker
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        if (this.worker !== worker) return
        const pending = this.pending.get(data.id)
        if (!pending) return
        if (typeof data.progress === 'string') { try { pending.progress?.(data.progress,data.progressDetails) } catch {} return }
        if (data.error) { this.dispose(String(data.error)); return }
        clearTimeout(pending.timer); pending.unlisten(); this.pending.delete(data.id)
        pending.resolve(data.result)
        this.idleTimer = setTimeout(() => this.dispose(), 120000)
      }
      worker.onerror = () => this.dispose('Could not start the local model. Try another model or browser.')
      worker.onmessageerror = () => this.dispose('The local model returned an unreadable response.')
    }
    const id = ++this.serial
    return new Promise<FilterResult>((resolve, reject) => {
      const abort = () => this.dispose('Local filtering cancelled.')
      const timer = setTimeout(() => this.dispose('The local model took too long. Try a smaller model or another device.'), timeout)
      const unlisten = () => signal?.removeEventListener('abort', abort)
      this.pending.set(id, { resolve, reject, progress, timer, unlisten })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      try { this.worker.postMessage({ ...data, id }) }
      catch { this.dispose('Could not send work to the local model.') }
    })
  }
  load(modelId: string, device = 'auto', onProgress?: ProgressHandler) {
    try { validateModel(modelId, device) } catch (error) { return Promise.reject(error) }
    return this.exclusive(async () => {
      this.info = null; this.cache.clear()
      const result = await this.request({ type: 'load', model: modelId, device }, onProgress, 600000)
      this.info = Object.freeze({ ...result, model: modelId, revision: FEED_MODELS[modelId].revision })
      return this.info
    })
  }
  classify(condition: string, listingText: string, { signal }: { signal?: AbortSignal } = {}) {
    try { validateInput(condition, listingText) } catch (error) { return Promise.reject(error) }
    const content = listingText.slice(0, MAX_LISTING_LENGTH)
    const clipped = listingText.length > MAX_LISTING_LENGTH
    return this.exclusive(async () => {
      if (signal?.aborted) throw new DOMException('Local filtering cancelled.', 'AbortError')
      if (!this.info || !this.worker) throw new Error('Load a local model first.')
      const key = JSON.stringify([FILTER_VERSION, this.info.model, this.info.revision, this.info.device, condition.trim(), content, clipped])
      const cached = this.cache.get(key)
      if (cached) return { ...cached, cached: true }
      const result = await this.request({ type: 'classify', condition: condition.trim(), content }, undefined, 60000, signal)
      if (!Number.isFinite(result?.score) || result.score < 0 || result.score > 1) {
        this.dispose(); throw new Error('The local model returned an invalid score.')
      }
      const decision = Object.freeze({ ...result, show: result.score >= 0.5, truncated: clipped || !!result.truncated })
      if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value)
      this.cache.set(key, decision)
      return { ...decision, cached: false }
    })
  }
  dispose(message = 'Local filter stopped.') {
    this.generation++
    clearTimeout(this.idleTimer); this.idleTimer = null
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null
      this.worker.terminate(); this.worker = null
    }
    this.info = null; this.cache.clear()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.unlisten(); pending.reject(new Error(message))
    }
    this.pending.clear()
  }
}
export const feedFilterClient = new FeedFilterClient()
