import test from 'node:test'
import assert from 'node:assert/strict'
import { marketAssets } from '../scripts/vite-assets.ts'

async function headers(downloads) {
  let handler
  const plugin = marketAssets(downloads)
  plugin.configureServer({ config: { base: '/', root: '/unused' }, middlewares: { use(value) { handler = value } } })
  const headers = {}
  await handler({ url: '/' }, { setHeader(name, value) { headers[name] = value } }, () => {})
  return headers['Content-Security-Policy']
}

test('Market permits signed snapshot reads and excludes the retired graph API', async () => {
  const origin = 'https://graph-api.iris.to'
  const market = (await headers(false)).match(/connect-src ([^;]+)/)[1].split(/\s+/)
  const downloads = (await headers(true)).match(/connect-src ([^;]+)/)[1].split(/\s+/)
  assert(market.includes('https://cdn.iris.to'))
  assert(market.includes('wss:'))
  assert(!market.includes(origin))
  assert(!market.includes('https:'))
  assert(!downloads.includes(origin))
})
