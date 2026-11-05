import { build } from 'esbuild';
import type { Plugin } from 'vite';
import { writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { GRAPH_BOOTSTRAP } from '../src/graph-bootstrap.ts';
import { CPU_RUNTIME, RUNTIME } from '../src/feed-filter/runtime.ts';
import { previewHandler, unregisterWorker } from './serve.mjs';
import { buildPwa } from './pwa-build.mjs';
import { DEFAULT_RELAYS } from '../src/market.ts';

const root = resolve(import.meta.dirname, '..');
const maxAssetBytes = 25 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function writeNotices(dest: string, moduleIds: Iterable<string>, includeRuntime: boolean) {
  const packages = new Set<string>();
  for (const fullPath of moduleIds) {
    if (!fullPath.startsWith(root + sep)) continue;
    const marker = `${sep}node_modules${sep}`;
    const index = fullPath.lastIndexOf(marker);
    if (index < 0) continue;
    const rest = fullPath.slice(index + marker.length).split(sep);
    const count = rest[0].startsWith('@') ? 2 : 1;
    packages.add(fullPath.slice(0, index + marker.length) + rest.slice(0, count).join(sep));
  }
  const notices = [
    `Iris Market\n${await readFile(resolve(root, '../LICENSE'), 'utf8')}`,
    `Adapted Iris feed-filter source\n${await readFile(resolve(root, 'src/feed-filter/LICENSE'), 'utf8')}`,
    `Iris Kit profile helpers\n${await readFile(resolve(root, 'src/shared/iris-kit/LICENSE.txt'), 'utf8')}`,
    `Iris Chat messaging adapters\n${await readFile(resolve(root, 'src/messaging/IRIS_CHAT_LICENSE.txt'), 'utf8')}`,
    `Iris Client image proxy\n${await readFile(resolve(root, 'licenses/IRIS-CLIENT-LICENSE.txt'), 'utf8')}`,
  ];
  if(includeRuntime)notices.push(`MiniLM topic vectors (derived from the Iris Client keyword index)\n${await readFile(resolve(root,'licenses/MINILM-NOTICE.txt'),'utf8')}\n${await readFile(resolve(root,'licenses/MINILM-LICENSE.txt'),'utf8')}`);
  for (const folder of [...packages].sort()) {
    const info = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
    const files = (await readdir(folder, { withFileTypes: true }))
      .filter(file => file.isFile() && /^(licen[sc]e|copying|notice)(?:[.-]|$)/i.test(file.name))
      .map(file => file.name).sort();
    const pinnedGraph = info.name === 'nostr-social-graph' && info.version === '4.0.3';
    if (!files.length && !pinnedGraph && !['pmtiles','nostr-double-ratchet','@fips/tcp','qrcode-generator'].includes(info.name) && !info.name.startsWith('onnxruntime-')) {
      throw new Error(`Missing bundled dependency license: ${info.name}@${info.version}`);
    }
    const texts = await Promise.all(files.map(file => readFile(resolve(folder, file), 'utf8')));
    // The verified v4.0.3 tarball omits its root license; source dc81464d34ee2199f0c22f9eab0d94483fa8af4c.
    if (pinnedGraph) {
      const license = await readFile(resolve(root, 'licenses/NOSTR-SOCIAL-GRAPH-LICENSE.txt'));
      if (hash(license) !== '51e841f44c5981b71373b68d6b4def2f84151dc90a05b7d25f5f0d87ad1c3f2e') throw new Error('Unexpected social graph license payload');
      texts.push(license.toString(), await readFile(resolve(folder, 'src/vendor/LICENSE.negentropy'), 'utf8'));
    }
    if (info.name === 'nostr-double-ratchet') texts.push(await readFile(resolve(root, 'licenses/NOSTR-DOUBLE-RATCHET-LICENSE.txt'), 'utf8'));
    // fips-tcp's pinned 0.2.3 package omits its root license (upstream commit 975a368f597db5c86ca0231245493da92e4e5ea9).
    if (info.name === '@fips/tcp') texts.push(await readFile(resolve(root, 'licenses/FIPS-TCP-LICENSE.txt'), 'utf8'));
    // qrcode-generator 2.0.4 omits its root license; source 83b7e8fe3fddd3b0368dbafd6ce56995bd25e3c8.
    if (info.name === 'qrcode-generator') texts.push(await readFile(resolve(root, 'licenses/QRCODE-GENERATOR-LICENSE.txt'), 'utf8'));
    if (info.name === 'pmtiles') texts.push(await readFile(resolve(root, 'licenses/PMTILES-LICENSE.txt'), 'utf8'));
    notices.push(`${info.name}@${info.version} (${info.license ?? 'see license below'})\n${texts.join('\n\n') || 'Covered by the ONNX Runtime notices below.'}`);
  }
  if (includeRuntime) for (const file of ['ONNX-RUNTIME-LICENSE.txt', 'ONNX-RUNTIME-ThirdPartyNotices.txt']) {
    notices.push(`${file}\n${await readFile(resolve(root, 'licenses', file), 'utf8')}`);
  }
  await writeFile(resolve(dest, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n========================================\n\n'));
}

async function checkAssetSizes(folder: string) {
  let largest = { name: '', bytes: 0 };
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) {
      const child = await checkAssetSizes(path);
      if (child.bytes > largest.bytes) largest = child;
    } else if (entry.isFile()) {
      const { size } = await stat(path);
      if (size > maxAssetBytes) throw new Error(`Asset exceeds 25 MiB: ${relative(root, path)} (${size} bytes)`);
      if (size > largest.bytes) largest = { name: relative(root, path), bytes: size };
    }
  }
  return largest;
}

function assetHeaders(downloads: boolean, routeScript?: string, dev = false) {
  const routeHash = routeScript ? ` 'sha256-${createHash('sha256').update(routeScript).digest('base64')}'` : '';
  // NIP-11 capability checks use HTTPS on the configured default relay hosts.
  const relayOrigins = downloads ? [] : DEFAULT_RELAYS.map(relay => new URL(relay.replace(/^wss:/, 'https:')).origin);
  if (!downloads) relayOrigins.push('https://graph-api.iris.to');
  if (dev) {
    relayOrigins.push('ws://127.0.0.1:*', 'ws://localhost:*');
    if (process.env.MARKET_TEST_RELAY === '1') relayOrigins.push('http://127.0.0.1:4785');
  }
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': `camera=(), microphone=(), geolocation=${downloads ? '()' : '(self)'}`,
    'Content-Security-Policy': `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${routeHash}; worker-src 'self' blob:; style-src 'self'${dev ? " 'unsafe-inline'" : ''}; img-src 'self' data: blob: https:; connect-src 'self' wss: ${relayOrigins.join(' ')} https://mint.coinos.io https://testnut.cashu.space https://upload.iris.to https://api.coinbase.com https://cdn.iris.to https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.xethub.hf.co; object-src 'none'; base-uri ${downloads ? "'none'" : "'self'"}; frame-ancestors 'none'; form-action 'self'`,
  };
}

const mapFiles = ['maplibre-gl.css', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];
const runtimeFolder = resolve(root, 'node_modules/onnxruntime-web/dist');

async function classicScript(entry: string) {
  const result = await build({ entryPoints: [resolve(root, 'src', entry)], bundle: true, minify: true, format: 'iife', target: 'es2022', write: false });
  return result.outputFiles[0].text.trim();
}

async function compressedRuntime(runtime: typeof RUNTIME | typeof CPU_RUNTIME) {
  const bytes = await readFile(resolve(runtimeFolder, runtime.wasm.replace(/\.gz$/, '')));
  if (bytes.length !== runtime.byteLength || hash(bytes) !== runtime.sha256) throw new Error('The installed ONNX runtime does not match the pinned payload.');
  const compressed = gzipSync(bytes, { level: 9 });
  if (compressed.readUInt32LE(4) !== 0 || compressed.length > runtime.maxCompressedBytes) throw new Error('Unexpected gzip runtime size or metadata.');
  return compressed;
}

// Both servers use the same named assets. Only the production build writes them to dist.
function assetSources(downloads: boolean) {
  const sources = new Map<string, () => Promise<string | Buffer>>();
  const file = (name: string, path = name) => sources.set(name, () => readFile(resolve(root, path)));
  file('icon.svg');
  sources.set('theme-init.js', () => classicScript('theme-init.ts'));
  if (downloads) {
    file('styles.css');
    for (const name of ['app-light.jpg', 'app-dark.jpg']) file(name, '../site/' + name);
  } else {
    for (const name of ['demo-delivery.svg', 'demo-ride.svg', 'manifest.webmanifest']) file(name);
    for (const size of [180, 192, 512, 1024]) file(`pwa-icon-${size}.png`);
    file('escrow.css', '../shared/escrow/trade.css');
    file('topic-vectors.bin', 'assets/topic-vectors.bin');
    for (const name of mapFiles) file(name, 'node_modules/maplibre-gl/dist/' + name);
    sources.set('social-graph.bin', async () => {
      const bytes = await readFile(resolve(root, GRAPH_BOOTSTRAP.packagePath));
      if (bytes.length !== GRAPH_BOOTSTRAP.byteLength || hash(bytes) !== GRAPH_BOOTSTRAP.sha256) throw new Error('Unexpected social graph bootstrap payload');
      return bytes;
    });
    for (const runtime of [CPU_RUNTIME, RUNTIME]) {
      file(runtime.mjs, resolve(runtimeFolder, runtime.mjs));
      sources.set(runtime.wasm, () => compressedRuntime(runtime));
    }
  }
  return sources;
}

const mime = { css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', svg: 'image/svg+xml', jpg: 'image/jpeg', png: 'image/png', webmanifest: 'application/manifest+json' };

export function marketAssets(downloads: boolean): Plugin {
  const assets = assetSources(downloads);
  let routeScript: string;
  return {
    name: 'market-assets',
    async transformIndexHtml(html, { server }) {
      const marker = '<!-- route-bootstrap -->';
      if (!html.includes(marker)) return html;
      // A dev server knows its mount even on the first request to a nested route.
      if (server) return html.replace(marker, `<base href="${server.config.base}">`);
      routeScript = await classicScript('route-init.ts');
      return html.replace(marker, `<script>${routeScript}</script>`);
    },
    configureServer(server) {
      const base = server.config.base;
      if (process.env.MARKET_PWA_TEST === '1') {
        server.middlewares.use(previewHandler(resolve(server.config.root, 'dist'), base, downloads));
        return;
      }
      server.middlewares.use(async (request, response, next) => {
        for (const [key, value] of Object.entries(assetHeaders(downloads, routeScript, true))) response.setHeader(key, value);
        const path = new URL(request.url, 'http://localhost').pathname;
        if (!path.startsWith(base)) return next();
        const name = path.slice(base.length);
        const get = assets.get(name);
        try {
          let body;
          if (get) body = await get();
          else if (!downloads && name === 'sw.js') body = unregisterWorker;
          else if (!downloads && name === 'nostr.worker.js') body = 'import "./src/nostr.worker.ts"';
          else if (!downloads && name === 'feed-filter.worker.js') body = 'import "./src/feed-filter/worker.ts"';
          else return next();
          response.setHeader('Content-Type', mime[name.split('.').pop()] || 'application/octet-stream');
          response.setHeader('Cache-Control', 'no-store');
          response.end(body);
        } catch (error) { next(error); }
      });
    },
    async writeBundle({ dir }, bundle) {
      for (const [name, get] of assets) await writeFile(resolve(dir, name), await get());
      const moduleIds = this.getModuleIds();
      await writeNotices(dir, moduleIds, !downloads);
      const headers = Object.entries(assetHeaders(downloads, routeScript)).map(([key, value]) => `  ${key}: ${value}`);
      await writeFile(resolve(dir, '_headers'), ['/*', ...headers, ''].join('\n'));
      await writeFile(resolve(dir, 'robots.txt'), 'User-agent: *\nAllow: /\n');
      if (downloads) {
        const html = await readFile(resolve(dir, 'index.html'), 'utf8');
        for (const [, src] of html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/g)) {
          if (/^(?:https?:|data:)/.test(src)) continue;
          const image = resolve(dir, src);
          if (relative(dir, image).startsWith('..') || !(await stat(image)).isFile()) throw new Error(`Download page image is missing: ${src}`);
        }
      } else {
        // The native map is a separate online page. The AI runtimes load on demand.
        const onDemand = new Set<string>(['native-map.html', CPU_RUNTIME.mjs, CPU_RUNTIME.wasm, RUNTIME.mjs, RUNTIME.wasm]);
        const paths = [...Object.keys(bundle), ...assets.keys()].filter(name => !onDemand.has(name));
        const offline = await buildPwa({ root, dest: dir, paths });
        console.log(`offline: ${offline.assets} verified assets, ${offline.bytes} bytes`);
      }
      const largest = await checkAssetSizes(dir);
      console.log(`${downloads ? 'site' : 'web'}: largest asset ${largest.name}, ${largest.bytes} bytes (limit ${maxAssetBytes})`);
    },
  };
}
