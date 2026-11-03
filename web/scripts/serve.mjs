import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

export const unregisterWorker = "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.registration.unregister()));";
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const appRoute = /^\/(?:invite|npub1[a-z0-9]+(?:\/[^/]+)?|naddr1[a-z0-9]+|post|saved|search|messages(?:\/[^/]+)?|orders(?:\/[^/]+)?|wallet|courier|settings(?:\/profile)?)\/?$/;

export function previewHandler(base, prefix, downloads) {
  return async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (!pathname.startsWith(prefix)) throw new Error('Outside mount');
      const name = '/' + pathname.slice(prefix.length);
      if (name === '/sw.js' && process.env.MARKET_PWA_TEST !== '1') {
        response.writeHead(200, { 'Content-Type': types['.js'], 'Cache-Control': 'no-store' });
        return response.end(unregisterWorker);
      }
      let target = resolve(base, name === '/' ? 'index.html' : '.' + name);
      if (!target.startsWith(base + sep)) {
        response.writeHead(403);
        return response.end();
      }
      let data;
      try {
        data = await readFile(target);
      } catch (error) {
        if (downloads || !appRoute.test(name) || error.code !== 'ENOENT') throw error;
        target = resolve(base, 'index.html');
        data = await readFile(target);
      }
      const headers = await readFile(resolve(base, '_headers'), 'utf8');
      for (const [, key, value] of headers.matchAll(/^  ([^:]+): (.+)$/gm)) {
        response.setHeader(key, key === 'Content-Security-Policy' && process.env.MARKET_TEST_RELAY === '1'
          ? value.replace('wss:', 'wss: ws://127.0.0.1:4785 http://127.0.0.1:4785') : value);
      }
      response.setHeader('Content-Type', types[extname(target)] || 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-store');
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT || 4173);
  const prefix = process.env.MARKET_BASE_PATH || '/';
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(prefix)) throw new Error('Use a slash-delimited local base path.');
  const downloads = process.env.MARKET_SITE === 'downloads';
  const directory = resolve(import.meta.dirname, downloads ? '../../site/dist' : '../dist');
  http.createServer(previewHandler(directory, prefix, downloads))
    .listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}${prefix}`));
}
