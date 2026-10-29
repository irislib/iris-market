export type FeedModelId = 'qwen35' | 'deberta'
export type FeedDevice = 'auto' | 'webgpu' | 'wasm'
export type ProgressHandler = (message: string) => void
export interface FeedModelSpec {
  label: string; downloadMB: number; requiresWebGPU: boolean
  repo: string; revision: string; dtype: 'q4' | 'q8'; files: Readonly<Record<string, string>>
}
export interface FeedModelInfo {
  device: Exclude<FeedDevice, 'auto'>; model: string; revision: string; dtype: string; loadMilliseconds: number
}
export interface ClassificationResult { score: number; milliseconds: number; inputTokens: number; truncated: boolean }
export interface FeedDecision extends ClassificationResult { show: boolean }
export type FilterRequest = { type: 'load'; model: string; device: string } | { type: 'classify'; condition: string; content: string }
export type FilterResult = FeedModelInfo | ClassificationResult
export interface WorkerResponse { id: number; progress?: string; error?: string; result?: FilterResult }
