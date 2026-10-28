import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { RUNTIME } from '../src/feed-filter/runtime.js';

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
  ];
  for (const folder of [...packages].sort()) {
    const info = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8'));
    const files = (await readdir(folder, { withFileTypes: true }))
      .filter(file => file.isFile() && /^(licen[sc]e|copying|notice)(?:[.-]|$)/i.test(file.name))
      .map(file => file.name).sort();
    if (!files.length && !info.name.startsWith('onnxruntime-')) {
      throw new Error(`Missing bundled dependency license: ${info.name}@${info.version}`);
    }
    const texts = await Promise.all(files.map(file => readFile(resolve(folder, file), 'utf8')));
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

for (const [name, source, entry] of [['web', root, 'src/app.js'], ['site', resolve(root, '../site'), 'app.js']]) {
  const dest = resolve(source, 'dist');
  await mkdir(dest, { recursive: true });
  const results = [await build({ absWorkingDir: root, entryPoints: [resolve(source, entry)], bundle: true, minify: true, format: 'esm', target: 'es2022', outfile: resolve(dest, 'app.js'), legalComments: 'eof', metafile: true })];
  for (const file of ['styles.css', 'icon.svg']) await copyFile(resolve(root, file), resolve(dest, file));
  await copyFile(resolve(root, 'src/theme-init.js'), resolve(dest, 'theme-init.js'));
  await copyFile(resolve(source, 'index.html'), resolve(dest, 'index.html'));
  if (name === 'site') for (const file of ['app-light.png', 'app-dark.png']) await copyFile(resolve(source, file), resolve(dest, file));
  if (name === 'web') {
    results.push(await build({ absWorkingDir: root, entryPoints: [resolve(root, 'src/feed-filter/worker.js')], bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: resolve(dest, 'feed-filter.worker.js'), legalComments: 'eof', metafile: true }));
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
  const headers = `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self'; img-src 'self' data: https:; connect-src 'self' wss: https://huggingface.co https://*.huggingface.co https://*.hf.co https://*.xethub.hf.co; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'\n`;
  await writeFile(resolve(dest, '_headers'), headers);
  await writeFile(resolve(dest, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  const largest = await checkAssetSizes(dest);
  console.log(`${name}: largest asset ${largest.name}, ${largest.bytes} bytes (limit ${maxAssetBytes})`);
}
