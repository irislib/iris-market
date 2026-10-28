import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkPortableHtml, manifest, parsePublication, publicReadEnvironment, requireManifest } from './publish-hashtree.mjs';

test('an asset changed after acceptance cannot pass the manifest gate', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'market-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'index.html'), '<script src="./app.js"></script>');
  await writeFile(path.join(directory, 'app.js'), 'first');
  const accepted = await manifest(directory);
  requireManifest(await manifest(directory), accepted.sha256);
  await writeFile(path.join(directory, 'app.js'), 'other');
  assert.throws(() => requireManifest({ sha256: 'x' }, accepted.sha256), /differs/);
  const changed = await manifest(directory);
  assert.throws(() => requireManifest(changed, accepted.sha256), /differs/);
  assert.equal(changed.bytes, accepted.bytes);
});

test('release refuses links outside the built directory and root-relative HTML assets', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'market-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'index.html'), '<link href="/styles.css"><img src="https://example.com/photo">');
  await assert.rejects(checkPortableHtml(directory, (await manifest(directory)).files), /Root-relative/);
  await writeFile(path.join(directory, 'index.html'), '<link href="./styles.css"><img src="https://example.com/photo">');
  await checkPortableHtml(directory, (await manifest(directory)).files);
  await symlink(path.join(directory, 'index.html'), path.join(directory, 'linked.html'));
  await assert.rejects(manifest(directory), /Symlinks/);
});

test('public reader does not inherit publisher keys, config, cache, daemon, or repair flags', () => {
  const env = publicReadEnvironment({ PATH: '/bin', NOSTR_SECRET_KEY: 'secret', NOSTR_RELAYS: 'ws://127.0.0.1', HTREE_CONFIG_DIR: '/publisher', HTREE_DATA_DIR: '/cache', HTREE_LOCAL_DAEMON_ONLY: '1', HTREE_GIT_REBUILD_FROM_LOCAL: '1', HTREE_LMDB_EXTERNAL_BLOB_DIR: '/shared' }, '/fresh');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HTREE_CONFIG_DIR, '/fresh/config');
  assert.equal(env.HTREE_DATA_DIR, '/fresh/data');
  assert.equal(env.HTREE_PREFER_LOCAL_DAEMON, '0');
  assert.equal(env.NOSTR_PREFER_LOCAL, '0');
  for (const key of ['NOSTR_SECRET_KEY', 'NOSTR_RELAYS', 'HTREE_LOCAL_DAEMON_ONLY', 'HTREE_GIT_REBUILD_FROM_LOCAL', 'HTREE_LMDB_EXTERNAL_BLOB_DIR']) assert.equal(env[key], undefined);
});

test('publication requires both a public reference and immutable hash, and refuses partial uploads', () => {
  const output = 'added .\n  url: nhash1qqqqqqqq\n  key: content-key\n  published: npub1example/market\n';
  assert.deepEqual(parsePublication(output), { nhash: 'nhash1qqqqqqqq', published: 'npub1example/market' });
  assert.throws(() => parsePublication(`${output}\nErrors: 1`), /incomplete/);
  assert.throws(() => parsePublication(`${output}\nfile server push failed`), /incomplete/);
  assert.throws(() => parsePublication('added .'), /Missing/);
});
