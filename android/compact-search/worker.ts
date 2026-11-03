import './local-fetch.ts'
import { env } from '@huggingface/transformers'
import '../../web/src/feed-filter/worker.ts'

// Settings owns installation and removal. Keep model bytes out of WebView storage.
env.useBrowserCache = false
