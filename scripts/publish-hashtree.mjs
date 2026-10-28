#!/usr/bin/env node
// Static-site publication only: build and test first, then pass the exact commit
// and manifest printed by inspect. No build, download, or forced update occurs.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const targets = { web: { directory: 'web/dist', tree: 'market' }, downloads: { directory: 'site/dist', tree: 'getmarket' } };
// Reviewed Darwin arm64 helper payload from source-built haps 0.1.22,
// source f58d7fa30e149c8f0e500bd7cd59da7e834cc61c (htree 0.2.150).
// This pins the release tool; it does not claim reproducibility of its binary.
export const HTREE_SHA256 = '6adb9c920dffc0ae39a94c86730555ef9ed781e9a7cfdea2c955eb3036c929ea';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });

export async function manifest(directory) {
  const files = [];
  async function visit(relative = '') {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      const entry = path.posix.join(relative, name);
      const full = path.join(directory, entry);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not release assets: ${entry}`);
      if (stat.isDirectory()) await visit(entry);
      else if (stat.isFile()) files.push({ path: entry, bytes: stat.size, sha256: sha256(await readFile(full)) });
      else throw new Error(`Unsupported release asset: ${entry}`);
    }
  }
  await visit();
  if (!files.some(file => file.path === 'index.html')) throw new Error('Missing built index.html');
  return { sha256: sha256(JSON.stringify(files)), bytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
}

export function requireManifest(actual, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected || '') || actual.sha256 !== expected) throw new Error('Asset manifest differs from the verified release');
}

export async function checkPortableHtml(directory, files) {
  for (const file of files.filter(file => file.path.endsWith('.html'))) {
    const html = await readFile(path.join(directory, file.path), 'utf8');
    if (/\b(?:src|href)\s*=\s*["']\/(?!\/)/i.test(html)) throw new Error(`Root-relative asset or link in ${file.path}`);
  }
}

export function publicReadEnvironment(environment, temporary) {
  const env = { ...environment };
  for (const key of Object.keys(env)) if (/^(?:HTREE_|NOSTR_)/.test(key)) delete env[key];
  return { ...env, HTREE_CONFIG_DIR: path.join(temporary, 'config'), HTREE_DATA_DIR: path.join(temporary, 'data'), NOSTR_PREFER_LOCAL: '0', HTREE_PREFER_LOCAL_DAEMON: '0', HTREE_PREFER_LOCAL_RELAY: '0' };
}

export function parsePublication(output) {
  if (/file server push failed|Errors:\s*[1-9]/i.test(output)) throw new Error('Hashtree reported incomplete file-server upload');
  const nhash = output.match(/\bnhash1[ac-hj-np-z02-9]+\b/i)?.[0];
  const published = output.match(/^\s*published:\s+(\S+)\s*$/im)?.[1];
  if (!nhash || !published) throw new Error('Missing immutable hash or published reference in Hashtree output');
  return { nhash, published };
}

function git(...args) { return run('git', args, { cwd: root }).trim(); }
function runHtree(binary, args, options) {
  const result = spawnSync(binary, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  if (result.error || result.status !== 0) throw new Error(`htree command failed (${result.status ?? result.error?.code ?? result.signal})`);
  return `${result.stdout}\n${result.stderr}`;
}
async function helper() {
  const binary = process.env.HTREE_BIN;
  if (!binary || !path.isAbsolute(binary)) throw new Error('Set HTREE_BIN to the pinned htree executable (absolute path)');
  if (sha256(await readFile(binary)) !== HTREE_SHA256) throw new Error('htree helper SHA-256 does not match the reviewed release tool');
  return binary;
}

export async function main(argv = process.argv.slice(2)) {
  const [operation, target, ...flags] = argv;
  if (!operation || operation === '--help') {
    console.log('node scripts/publish-hashtree.mjs inspect web|downloads\nnode scripts/publish-hashtree.mjs publish web|downloads --commit FULL_COMMIT --assets MANIFEST_SHA256\nnode scripts/publish-hashtree.mjs verify web|downloads --ref NHASH --assets MANIFEST_SHA256\nPublishing and verification require HTREE_BIN. Publish only after UI and production build acceptance.');
    return;
  }
  if (!['inspect', 'publish', 'verify'].includes(operation) || !Object.hasOwn(targets, target)) throw new Error('Unknown operation or target; use --help');
  const options = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--commit', '--assets', '--ref'].includes(flags[i]) || !flags[i + 1] || options[flags[i]]) throw new Error('Invalid or duplicate option');
    options[flags[i]] = flags[i + 1];
  }
  const directory = path.join(root, targets[target].directory);
  if (operation === 'inspect') {
    const assets = await manifest(directory);
    console.log(JSON.stringify({ target, commit: git('rev-parse', 'HEAD'), clean: !git('status', '--porcelain=v1'), ...assets }, null, 2));
    return;
  }
  const binary = await helper();
  if (operation === 'verify') {
    if (!/^nhash1[ac-hj-np-z02-9]+$/i.test(options['--ref'] || '')) throw new Error('Verification requires the immutable nhash from publication');
    if (!/^[a-f0-9]{64}$/.test(options['--assets'] || '')) throw new Error('Verification requires the accepted asset manifest');
    const temporary = await mkdtemp(path.join(tmpdir(), 'iris-market-public-read-'));
    const env = publicReadEnvironment(process.env, temporary);
    try {
      await mkdir(env.HTREE_CONFIG_DIR);
      await writeFile(path.join(env.HTREE_CONFIG_DIR, 'config.toml'), '[updater]\nauto_check = false\nauto_install = false\n');
      const output = path.join(temporary, 'site');
      runHtree(binary, ['get', options['--ref'], '-o', output], { env });
      const downloaded = await manifest(output);
      requireManifest(downloaded, options['--assets']);
      console.log(JSON.stringify({ target, verified: true, nhash: options['--ref'], sha256: downloaded.sha256, bytes: downloaded.bytes, files: downloaded.files.length, reader: 'fresh config and cache, no signing identity or local daemon' }));
    } finally { await rm(temporary, { recursive: true, force: true }); }
    return;
  }
  const commit = options['--commit'];
  if (!/^[a-f0-9]{40}$/.test(commit || '') || git('rev-parse', 'HEAD') !== commit) throw new Error('HEAD must equal the accepted full source commit');
  if (git('status', '--porcelain=v1')) throw new Error('Commit source changes before publishing');
  const assets = await manifest(directory);
  requireManifest(assets, options['--assets']);
  await checkPortableHtml(directory, assets.files);
  const env = { ...process.env, NOSTR_PREFER_LOCAL: '0', HTREE_PREFER_LOCAL_DAEMON: '0' };
  for (const key of ['NOSTR_SECRET_KEY', 'HTREE_LOCAL_DAEMON_ONLY', 'HTREE_GIT_REBUILD_FROM_LOCAL']) delete env[key];
  // Capture tool output so identity/key lines and operational paths never enter
  // the public release record. An upload failure still fails this command.
  const publication = runHtree(binary, ['add', '.', '--publish', targets[target].tree], { cwd: directory, env });
  const result = parsePublication(publication);
  requireManifest(await manifest(directory), assets.sha256);
  console.log(JSON.stringify({ target, commit, sha256: assets.sha256, bytes: assets.bytes, files: assets.files.length, ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Hashtree release failed: ${error.status == null ? error.message : `helper exited ${error.status}`}`); process.exitCode = 1; });
}
