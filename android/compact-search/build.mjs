// Use the web lockfile, runtime integrity metadata and production classifier.
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { CPU_RUNTIME } from '../../web/src/feed-filter/runtime.ts'
import { FEED_MODELS } from '../../web/src/feed-filter/models.ts'

const source = import.meta.dirname
const web = resolve(source, '../../web')
const out = resolve(process.argv[2])
const modules = join(web, 'node_modules')
const { build } = createRequire(join(web, 'package.json'))('esbuild')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = readFileSync(resolve(source, '../app/src/main/java/to/iris/market/CompactSearchModel.kt'), 'utf8')
if (![FEED_MODELS.deberta.revision, FEED_MODELS.deberta.files['model_quantized.onnx']].every(x => manifest.includes(x)))
  throw Error('Android model download and web model revisions disagree.')

const runtime = join(modules, 'onnxruntime-web/dist')
const wasm = readFileSync(join(runtime, CPU_RUNTIME.wasm.replace(/\.gz$/, '')))
const module = readFileSync(join(runtime, CPU_RUNTIME.mjs))
if (wasm.length !== CPU_RUNTIME.byteLength || hash(wasm) !== CPU_RUNTIME.sha256 ||
    hash(module) !== 'c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f')
  throw Error('Unexpected CPU runtime.')
mkdirSync(out, { recursive: true })
// AAPT treats .gz as a directive to decompress and rename. Keep the gzip
// payload byte-for-byte under a neutral APK filename; the local host maps it.
rmSync(join(out, CPU_RUNTIME.wasm), { force: true })
writeFileSync(join(out, CPU_RUNTIME.wasm.replace(/\.gz$/, '.bin')), gzipSync(wasm, { level: 9 }))
writeFileSync(join(out, CPU_RUNTIME.mjs), module)
copyFileSync(join(web, 'assets/topic-vectors.bin'), join(out, 'topic-vectors.bin'))

const lock = JSON.parse(readFileSync(join(web, 'package-lock.json'), 'utf8'))
const notices = ['../LICENSE', 'src/feed-filter/LICENSE', 'licenses/MINILM-NOTICE.txt', 'licenses/MINILM-LICENSE.txt',
  'licenses/ONNX-RUNTIME-LICENSE.txt', 'licenses/ONNX-RUNTIME-ThirdPartyNotices.txt']
for (const name of ['@huggingface/transformers', '@noble/hashes', 'onnxruntime-web', 'esbuild']) {
  const installed = JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8'))
  if (installed.version !== lock.packages['node_modules/' + name].version) throw Error('Install the locked web dependencies.')
  if (['@huggingface/transformers', '@noble/hashes'].includes(name)) notices.push('node_modules/' + name + '/LICENSE')
}
writeFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), notices.map(path => path + '\n' + readFileSync(join(web,path),'utf8')).join('\n\n'))
for (const entry of ['page', 'worker']) {
  await build({
    absWorkingDir: web, nodePaths: [modules], bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022', minify: true,
    entryPoints: [join(source, entry + '.ts')], outfile: join(out, entry + '.js')
  })
}
writeFileSync(join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>\n')
