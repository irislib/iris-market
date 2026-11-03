import { resolve } from 'node:path'
import { defaultClientConditions, defineConfig } from 'vite'
import { marketAssets } from './scripts/vite-assets.ts'

const web = import.meta.dirname

export default defineConfig(({ command, mode }) => {
  const downloads = mode === 'downloads' || (command === 'serve' && process.env.MARKET_SITE === 'downloads')
  const root = downloads ? resolve(web, '../site') : web
  const base = process.env.MARKET_BASE_PATH || '/'
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error('Use a slash-delimited local base path.')

  return {
    root,
    base: command === 'build' ? './' : base,
    cacheDir: resolve(web, downloads ? 'node_modules/.vite-downloads' : 'node_modules/.vite'),
    publicDir: false,
    envDir: false,
    envPrefix: [],
    // Supply verified WASM bytes ourselves instead of bundling ONNX's fallback binary.
    resolve: { conditions: [...defaultClientConditions, 'onnxruntime-web-use-extern-wasm'] },
    optimizeDeps: {
      entries: downloads ? ['index.html'] : ['index.html', 'native-map.html', 'src/nostr.worker.ts', 'src/feed-filter/worker.ts'],
    },
    define: {
      'import.meta.env.VITE_TEST_MODE': 'false',
      'import.meta.env.VITE_TEST_BOOTSTRAP_PUBKEY': 'undefined',
    },
    plugins: [marketAssets(downloads)],
    server: {
      host: '127.0.0.1',
      port: Number(process.env.PORT || 4173),
      strictPort: true,
      fs: {
        allow: [web, resolve(web, '../site'), resolve(web, '../shared/home-feed.json')],
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.wrangler/**', resolve(web, 'work/**')],
      },
    },
    build: {
      target: 'es2022',
      modulePreload: false,
      rollupOptions: {
        input: {
          app: resolve(root, 'index.html'),
          ...(!downloads && {
            'native-map': resolve(web, 'native-map.html'),
            'nostr.worker': resolve(web, 'src/nostr.worker.ts'),
            'feed-filter.worker': resolve(web, 'src/feed-filter/worker.ts'),
          }),
        },
        output: { entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
      },
    },
  }
})
