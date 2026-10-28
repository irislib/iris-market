/*!
MIT License

Copyright (c) 2024 Martti Malmi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
/*! Adapted from Iris client's src/lib/feed-filter/models.ts (MIT, Copyright 2024 Martti Malmi).
 * Upstream pilot snapshot SHA256: 9fc4f83a7858457d60c2de67d89c96469272132faf674023e6a73998c5138f40.
 * License: ./LICENSE. Experimental marketplace quality is not established. */
export const FEED_MODELS = Object.freeze({
  qwen35: Object.freeze({
    label: 'Qwen 3.5 · about 551 MB', downloadMB: 551, requiresWebGPU: true,
    repo: 'onnx-community/Qwen3.5-0.8B-Text-ONNX', revision: '25cdf33f386b487a25f3d743e86442517bdb77ff', dtype: 'q4',
    files: Object.freeze({
      'model_q4.onnx': 'ea717eb57f3a00e0ac5dc5b537ef8385945f1fbd4f9323d8dd45aa652ae8554e',
      'model_q4.onnx_data': 'ac65b1f1220314ef2debc02545f5aa5702ec201e723ca45dce2bfefc85921859',
    }),
  }),
  deberta: Object.freeze({
    label: 'DeBERTa · about 87 MB', downloadMB: 87, requiresWebGPU: false,
    repo: 'Xenova/nli-deberta-v3-xsmall', revision: '2a4f614a701367a02d51389039afc998faeda637', dtype: 'q8',
    files: Object.freeze({ 'model_quantized.onnx': '3fac2500c45c75af42c7711de0d1b93d59577456100208be0dc1f9e8811946b6' }),
  }),
})
export const DEFAULT_FEED_MODEL = 'qwen35'
export const MAX_CONDITION_LENGTH = 500
export const MAX_LISTING_LENGTH = 2000
export const FILTER_VERSION = 2
export const isFeedModel = id => typeof id === 'string' && Object.hasOwn(FEED_MODELS, id)
export function validateModel(id, device) {
  if (!isFeedModel(id)) throw new Error('Choose a supported local model.')
  if (!['auto', 'webgpu', 'wasm'].includes(device)) throw new Error('Choose System, WebGPU, or CPU.')
  if (device === 'wasm' && FEED_MODELS[id].requiresWebGPU) throw new Error('This model needs WebGPU. Select DeBERTa for CPU filtering.')
}
export function validateInput(condition, text) {
  if (typeof condition !== 'string' || !condition.trim() || condition.length > MAX_CONDITION_LENGTH) throw new Error('Use a condition between 1 and 500 characters.')
  if (typeof text !== 'string') throw new Error('Provide listing text to classify.')
}
