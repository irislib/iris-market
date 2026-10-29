import type { FilterRequest } from './types.ts'
/*! Adapted from Iris client's feed-filter worker (MIT, Copyright 2024 Martti Malmi).
 * Pilot SHA256: 98305b76beb4667b70d4a8ec069384233c49437b6fdf6bc36d2cbe331c350498. License: ./LICENSE. */
import { loadModel, classifyListing, disposeModel } from './inference.ts'
let queue = Promise.resolve()
self.onmessage = ({ data }: MessageEvent<(FilterRequest | { type: 'dispose' }) & { id: number }>) => {
  queue = queue.then(async () => {
    const { id } = data
    try {
      let result
      if (data.type === 'load') result = await loadModel(data.model, data.device, (progress,progressDetails) => self.postMessage({ id, progress, progressDetails }))
      else if (data.type === 'classify') result = await classifyListing(data.condition, data.content)
      else if (data.type === 'dispose') result = await disposeModel()
      else throw new Error('Unknown local filter request.')
      self.postMessage({ id, result })
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : 'Local filtering failed.' })
    }
  })
}
