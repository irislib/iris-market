import type { FeedModelInfo, ClassificationResult, FeedDecision, FilterRequest, FilterResult, ProgressHandler, WorkerResponse } from './types.ts'
import {isTopicSearch} from '../search-condition.ts'
import { assetUrl } from '../asset-url.ts'
import {DecisionCache,decisionCacheKey} from './decision-cache.ts'
/*! Adapted from Iris client's src/lib/feed-filter/client.ts (MIT, Copyright 2024 Martti Malmi).
 * Upstream pilot snapshot SHA256: e25beb76a39d334d1e53159f8fa7abde84fdbc9fd27f3310d4a788018dbce09f.
 * License: ./LICENSE. Explicit loading, bounded caching, and cancellation for Iris Market. */
import { FEED_MODELS, FILTER_VERSION, MAX_LISTING_LENGTH, validateModel, validateInput } from './models.ts'
export { FEED_MODELS, DEFAULT_FEED_MODEL } from './models.ts'
export const FEED_FILTER_IDLE_MS = 15 * 60 * 1000

export class FeedFilterClient {
  Worker: typeof Worker
  workerUrl: string
  worker: Worker | null
  info: Readonly<FeedModelInfo> | null
  serial: number
  generation: number
  pending: Map<number, { resolve: (value: FilterResult) => void; reject: (reason?: unknown) => void; progress?: ProgressHandler; timer: ReturnType<typeof setTimeout>; unlisten: () => void }>
  cache: DecisionCache
  queue: Promise<unknown>
  queued: number
  idleTimer: ReturnType<typeof setTimeout> | null
  private pins = 0
  private leased = new Set<FeedFilterClient>()
  private auxPool: FeedFilterClient[] = []
  private auxIdleTimer: ReturnType<typeof setTimeout> | null = null
  constructor({ WorkerImpl = globalThis.Worker, workerUrl = assetUrl('feed-filter.worker.js'), decisionCache=new DecisionCache() } = {}) {
    this.Worker = WorkerImpl; this.workerUrl = workerUrl
    this.worker = null; this.info = null; this.serial = 0; this.generation = 0
    this.pending = new Map(); this.cache = decisionCache; this.queue = Promise.resolve(); this.queued = 0; this.idleTimer = null
  }
  /** A submitted search owns its model across cache hits and relay-page waits. */
  pin(): () => void {
    const generation = this.generation
    this.pins++; clearTimeout(this.idleTimer); this.idleTimer = null
    let released = false
    return () => {
      if (released) return
      released = true
      if (generation !== this.generation) return
      this.pins--; this.scheduleIdle()
    }
  }
  private scheduleIdle() {
    clearTimeout(this.idleTimer); this.idleTimer = null
    if (this.worker && !this.pins && !this.pending.size && !this.queued) {
      const generation = this.generation
      this.idleTimer = setTimeout(() => { if (generation === this.generation) this.dispose() }, FEED_FILTER_IDLE_MS)
    }
  }
  exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.queued >= 64) return Promise.reject(new Error('Too many listings are waiting for local filtering.'))
    const generation = this.generation
    clearTimeout(this.idleTimer); this.idleTimer = null
    this.queued++
    const result = this.queue.then(() => {
      if (generation !== this.generation) throw new Error('Local filter stopped.')
      return run()
    }).finally(() => { this.queued--; this.scheduleIdle() })
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
        this.scheduleIdle()
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
  private auxiliaryWorkerCount(): number {
    if (this.info?.model !== 'deberta' || this.info.device !== 'wasm') return 0
    const device = globalThis.navigator as Navigator & { deviceMemory?: number }
    const cores = Number(device?.hardwareConcurrency) || 0
    if (typeof device?.deviceMemory === 'number') {
      if (device.deviceMemory >= 8 && cores >= 8) return Math.min(3, Math.floor(cores / 3))
      if (device.deviceMemory >= 4 && cores >= 4) return 1
      return 0
    }
    // Safari and Firefox omit navigator.deviceMemory; scale conservatively on multi-core desktops.
    return cores >= 6 ? Math.min(2, Math.floor(cores / 4)) : 0
  }
  private scheduleAuxIdle() {
    clearTimeout(this.auxIdleTimer); this.auxIdleTimer = null
    if (!this.auxPool.length) return
    const generation = this.generation
    this.auxIdleTimer = setTimeout(() => {
      if (generation !== this.generation) return
      for (const worker of this.auxPool.splice(0)) worker.dispose()
    }, 2 * 60 * 1000)
    ;(this.auxIdleTimer as unknown as { unref?: () => void }).unref?.()
  }
  private leaseAuxiliary(worker: FeedFilterClient): FeedFilterClient {
    this.leased.add(worker)
    let released = false
    const owner = this
    return {
      get info() { return released || !owner.leased.has(worker) ? null : worker.info },
      classify: (condition, listingText, options) => released || !owner.leased.has(worker)
        ? Promise.reject(new Error('Local filter stopped.'))
        : worker.classify(condition, listingText, options),
      dispose(message?: string) {
        if (released) return
        released = true
        if (!owner.leased.delete(worker)) return
        // Keep healthy warm workers across back-to-back searches; terminate on error or owner reset.
        if (message || !worker.info || !worker.worker || worker.queued) {
          worker.dispose(message)
        } else {
          owner.auxPool.push(worker)
          owner.scheduleAuxIdle()
        }
      },
    } as FeedFilterClient
  }
  /** Bounded pool of warm CPU workers sharing the decision cache across searches. */
  startSearchWorkers(limit = Infinity): FeedFilterClient[] {
    const count = Math.min(limit, this.auxiliaryWorkerCount() - this.leased.size)
    if (count <= 0) return []
    const workers: FeedFilterClient[] = []
    while (workers.length < count && this.auxPool.length) {
      const reused = this.auxPool.pop()!
      if (reused.info && reused.worker) workers.push(reused)
      else reused.dispose()
    }
    while (workers.length < count) {
      const other = new FeedFilterClient({ WorkerImpl: this.Worker, workerUrl: this.workerUrl, decisionCache: this.cache })
      void other.load('deberta', 'wasm', undefined, true).catch(() => other.dispose())
      workers.push(other)
    }
    return workers.map(worker => this.leaseAuxiliary(worker))
  }
  /** An auxiliary CPU worker belongs to one search and shares its decision cache. */
  startSearchWorker(): FeedFilterClient | null {
    return this.startSearchWorkers(1)[0] ?? null
  }
  load(modelId: string, device = 'auto', onProgress?: ProgressHandler, cacheOnly=false) {
    try { validateModel(modelId, device) } catch (error) { return Promise.reject(error) }
    return this.exclusive(async () => {
      const backend = device === 'auto' ? (FEED_MODELS[modelId].requiresWebGPU ? 'webgpu' : 'wasm') : device
      if (this.info && this.info.device !== backend) {
        this.worker?.terminate()
        this.worker = null
      }
      this.info = null; const generation=this.generation
      const result = await this.request({ type: 'load', model: modelId, device, ...(cacheOnly && {cacheOnly}) }, onProgress, 600000)
      if(generation!==this.generation)throw new Error('Local filter stopped.')
      this.info = Object.freeze({ ...result, model: modelId, revision: FEED_MODELS[modelId].revision })
      return this.info
    })
  }
  /** Ask the loaded model once per query whether the user expresses a request.
   * The decision uses the same local cache as other model inputs. */
  async selectSearchHead(query:string,signal?:AbortSignal):Promise<boolean>{
    if(this.info?.model!=='deberta'||!query.trim()||isTopicSearch(query))return false
    const result=await this.classify('I am looking for this.',query,{signal})
    return result.score>=.35
  }
  classify(condition: string, listingText: string, { signal, eventId, searchHead = false }: { signal?: AbortSignal; eventId?: string; searchHead?: boolean } = {}) {
    try { validateInput(condition, listingText) } catch (error) { return Promise.reject(error) }
    const content = listingText.slice(0, MAX_LISTING_LENGTH)
    const clipped = listingText.length > MAX_LISTING_LENGTH
    return this.exclusive(async () => {
      if (signal?.aborted) throw new DOMException('Local filtering cancelled.', 'AbortError')
      if (!this.info || !this.worker) throw new Error('Load a local model first.')
      const generation=this.generation,info=this.info
      const key=decisionCacheKey({filterVersion:FILTER_VERSION,model:info.model,revision:searchHead ? info.revision + ":market-head-v1" : info.revision,device:info.device,dtype:FEED_MODELS[info.model].dtype,condition:condition.trim(),content,truncated:clipped,eventId})
      const cached = this.cache.get(key)
      if (cached) return { ...cached, cached: true }
      const result = await this.request({ type: 'classify', condition: condition.trim(), content, ...(searchHead ? { searchHead: true } : {}) }, undefined, 60000, signal)
      if(signal?.aborted||generation!==this.generation||this.info!==info)throw new DOMException('Local filtering cancelled.','AbortError')
      if (!Number.isFinite(result?.score) || result.score < 0 || result.score > 1) {
        this.dispose(); throw new Error('The local model returned an invalid score.')
      }
      const decision = Object.freeze({ ...result, show: result.score >= 0.5, truncated: clipped || !!result.truncated })
      this.cache.set(key, decision)
      return { ...decision, cached: false }
    })
  }
  dispose(message = 'Local filter stopped.') {
    this.generation++
    this.pins = 0
    clearTimeout(this.idleTimer); this.idleTimer = null
    clearTimeout(this.auxIdleTimer); this.auxIdleTimer = null
    for (const aux of this.leased) aux.dispose(message)
    this.leased.clear()
    for (const aux of this.auxPool.splice(0)) aux.dispose(message)
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null
      this.worker.terminate(); this.worker = null
    }
    this.info = null; void this.cache.flush()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.unlisten(); pending.reject(new Error(message))
    }
    this.pending.clear()
  }
}
export const feedFilterClient = new FeedFilterClient()
