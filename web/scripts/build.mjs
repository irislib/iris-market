import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { GRAPH_BOOTSTRAP } from '../src/graph-bootstrap.ts';
import { RUNTIME } from '../src/feed-filter/runtime.ts';
import { buildPwa } from './pwa-build.mjs';

const root = resolve(import.meta.dirname, '..');
const maxAssetBytes = 25 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function writeNotices(dest, bundleResults, includeRuntime) {
  const packages = new Set();
  for (const result of bundleResults) for (const input of Object.keys(result.metafile.inputs)) {
    const fullPath = resolve(root, input);
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
  for (const folder of [...packages].sort()) {
    const info = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
    const files = (await readdir(folder, { withFileTypes: true }))
      .filter(file => file.isFile() && /^(licen[sc]e|copying|notice)(?:[.-]|$)/i.test(file.name))
      .map(file => file.name).sort();
    if (!files.length && !['pmtiles','nostr-double-ratchet','@fips/tcp'].includes(info.name) && !info.name.startsWith('onnxruntime-')) {
      throw new Error(`Missing bundled dependency license: ${info.name}@${info.version}`);
    }
    const texts = await Promise.all(files.map(file => readFile(resolve(folder, file), 'utf8')));
    if (info.name === 'nostr-double-ratchet') texts.push(await readFile(resolve(root, 'licenses/NOSTR-DOUBLE-RATCHET-LICENSE.txt'), 'utf8'));
    // fips-tcp's pinned 0.2.3 package omits its root license (upstream commit 975a368f597db5c86ca0231245493da92e4e5ea9).
    if (info.name === '@fips/tcp') texts.push(await readFile(resolve(root, 'licenses/FIPS-TCP-LICENSE.txt'), 'utf8'));
    if (info.name === 'pmtiles') texts.push(await readFile(resolve(root, 'licenses/PMTILES-LICENSE.txt'), 'utf8'));
    notices.push(`${info.name}@${info.version} (${info.license ?? 'see license below'})\n${texts.join('\n\n') || 'Covered by the ONNX Runtime notices below.'}`);
  }
  if (includeRuntime) for (const file of ['ONNX-RUNTIME-LICENSE.txt', 'ONNX-RUNTIME-ThirdPartyNotices.txt']) {
    notices.push(`${file}\n${await readFile(resolve(root, 'licenses', file), 'utf8')}`);
  }
  await writeFile(resolve(dest, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n========================================\n\n'));
}

async function checkAssetSizes(folder) {
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

for (const [name, source, entry] of [['web', root, 'src/app.ts'], ['site', resolve(root, '../site'), 'app.ts']]) {
  const dest = resolve(source, 'dist');
  await mkdir(dest, { recursive: true });
  const results = [await build({ absWorkingDir: root, entryPoints: [resolve(source, entry)], bundle: true, minify: true, format: 'esm', target: 'es2022', outdir: dest, entryNames: 'app', chunkNames: 'chunks/[name]-[hash]', splitting: true, legalComments: 'eof', metafile: true })];
  for (const file of ['styles.css', 'icon.svg']) await copyFile(resolve(root, file), resolve(dest, file));
  await build({entryPoints:[resolve(root, 'src/theme-init.ts')],outfile:resolve(dest,'theme-init.js'),bundle:true,minify:true,target:'es2022'});
  let routeHash='';
  if(name==='web') {
    const bootstrap=await build({entryPoints:[resolve(root,'src/route-init.ts')],bundle:true,minify:true,format:'iife',target:'es2022',write:false});
    const script=bootstrap.outputFiles[0].text.trim();
    routeHash=` 'sha256-${createHash('sha256').update(script).digest('base64')}'`;
    const html=await readFile(resolve(source,'index.html'),'utf8');
    await writeFile(resolve(dest,'index.html'),html.replace('<!-- route-bootstrap -->',`<script>${script}</script>`));
  } else await copyFile(resolve(source, 'index.html'), resolve(dest, 'index.html'));
  if (name === 'site') {
    for (const file of ['app-light.jpg', 'app-dark.jpg']) await copyFile(resolve(source, file), resolve(dest, file));
    const html=await readFile(resolve(dest,'index.html'),'utf8');
    for(const [,src] of html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/g)) {
      if (/^(?:https?:|data:)/.test(src)) continue;
      const image=resolve(dest,src),path=relative(dest,image);
      if(path.startsWith('..')||!(await stat(image)).isFile())throw new Error(`Download page image is missing: ${src}`);
    }
  }
  if (name === 'web') {
    await copyFile(resolve(root, 'profiles.css'), resolve(dest, 'profiles.css'));
    await copyFile(resolve(root, 'account.css'), resolve(dest, 'account.css'));
    await copyFile(resolve(root, 'wallet.css'), resolve(dest, 'wallet.css'));
    await copyFile(resolve(root, 'orders.css'), resolve(dest, 'orders.css'));
    await copyFile(resolve(root, 'notifications.css'), resolve(dest, 'notifications.css'));
    const graphBytes = await readFile(resolve(root, GRAPH_BOOTSTRAP.packagePath));
    if (graphBytes.byteLength !== GRAPH_BOOTSTRAP.byteLength || hash(graphBytes) !== GRAPH_BOOTSTRAP.sha256) throw new Error('Unexpected social graph bootstrap payload');
    await writeFile(resolve(dest, 'social-graph.bin'), graphBytes);
    await copyFile(resolve(root, 'native-map.html'), resolve(dest, 'native-map.html'));
    for (const file of ['maplibre-gl.css','maplibre-gl-worker.mjs','maplibre-gl-shared.mjs']) await copyFile(resolve(root, 'node_modules/maplibre-gl/dist', file), resolve(dest, file));
    results.push(await build({ absWorkingDir: root, entryPoints: [resolve(root, 'src/native-map.ts')], bundle: true, minify: true, format: 'esm', target: 'es2022', outfile: resolve(dest, 'native-map.js'), legalComments: 'eof', metafile: true }));
    results.push(await build({ absWorkingDir: root, entryPoints: [resolve(root, 'src/nostr.worker.ts')], define: {'import.meta.env.VITE_TEST_MODE': 'false', 'import.meta.env.VITE_TEST_BOOTSTRAP_PUBKEY': 'undefined'}, bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: resolve(dest, 'nostr.worker.js'), legalComments: 'eof', metafile: true }));
    results.push(await build({ absWorkingDir: root, entryPoints: [resolve(root, 'src/feed-filter/worker.ts')], bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: resolve(dest, 'feed-filter.worker.js'), legalComments: 'eof', metafile: true }));
    const rawName = RUNTIME.wasm.replace(/\.gz$/, '');
    const binary = await readFile(resolve(root, 'node_modules/onnxruntime-web/dist', rawName));
    if (binary.byteLength !== RUNTIME.byteLength || hash(binary) !== RUNTIME.sha256) throw new Error('The installed ONNX runtime does not match the pinned payload.');
    // Node emits gzip with a zero timestamp and no source filename, keeping this deterministic.
    const compressed = gzipSync(binary, { level: 9 });
    if (compressed.readUInt32LE(4) !== 0 || compressed.length > RUNTIME.maxCompressedBytes) throw new Error('Unexpected gzip runtime size or metadata.');
    await writeFile(resolve(dest, RUNTIME.wasm), compressed);
    await copyFile(resolve(root, 'node_modules/onnxruntime-web/dist', RUNTIME.mjs), resolve(dest, RUNTIME.mjs));
    // Retire only this superseded generated file; preserve all other outputs.
    await rm(resolve(dest, rawName), { force: true });
    console.log(`runtime: ${binary.length} → ${compressed.length} bytes; SHA256 ${RUNTIME.sha256}`);
  }
  await writeNotices(dest, results, name === 'web');
  const headers = `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=${name === 'web' ? '(self)' : '()'}\n  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${routeHash}; worker-src 'self' blob:; style-src 'self'; img-src 'self' data: blob: https:; connect-src 'self' wss: https://mint.coinos.io https://upload.iris.to https://api.coinbase.com https://cdn.iris.to https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.xethub.hf.co; object-src 'none'; base-uri ${name==='web'?"'self'":"'none'"}; frame-ancestors 'none'; form-action 'self'\n`;
  await writeFile(resolve(dest, '_headers'), headers);
  await writeFile(resolve(dest, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  if (name === 'web') {
    const offline = await buildPwa({root,dest,results});
    console.log(`offline: ${offline.assets} verified assets, ${offline.bytes} bytes`);
  }
  const largest = await checkAssetSizes(dest);
  console.log(`${name}: largest asset ${largest.name}, ${largest.bytes} bytes (limit ${maxAssetBytes})`);
}
