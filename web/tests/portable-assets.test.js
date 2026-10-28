import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assetUrl, deploymentBase, invitationBase, captureInvitation } from '../src/asset-url.js';
import { FeedFilterClient } from '../src/feed-filter/client.js';
import { RUNTIME, loadRuntimeBinary } from '../src/feed-filter/runtime.js';
import { GRAPH_BOOTSTRAP, loadGraphBootstrap } from '../src/graph-bootstrap.js';

const origin = 'https://gateway.example';
const prefix = `${origin}/htree/nhash1example/market/`;

test('every HTML entry keeps own assets and home links under its deployment prefix', async () => {
  for (const file of ['../index.html','../../site/index.html','../native-map.html']) {
    const html = await readFile(new URL(file,import.meta.url),'utf8');
    const references = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map(match=>match[1]);
    assert(references.some(path=>path==='./styles.css'));
    for (const path of references) {
      if (path.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(path)) continue;
      assert(path.startsWith('./'),`${file} has root-relative reference ${path}`);
      assert(new URL(path,prefix).href.startsWith(prefix));
    }
  }
});

test('main-page worker, lazy chunk and map assets stay beside index.html rather than beside shared chunks', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis,'document');
  try {
    Object.defineProperty(globalThis,'document',{configurable:true,value:{baseURI:`${prefix}index.html?profile=test`}});
    const client = new FeedFilterClient({WorkerImpl:class {}});
    assert.equal(String(client.workerUrl),`${prefix}feed-filter.worker.js`);
    assert.equal(assetUrl('maplibre-gl-worker.mjs'),`${prefix}maplibre-gl-worker.mjs`);
    assert.equal(assetUrl('./chunks/map-EXAMPLE.js'),`${prefix}chunks/map-EXAMPLE.js`);
    assert.equal(assetUrl(GRAPH_BOOTSTRAP.url),`${prefix}social-graph.bin`);
    assert.equal(deploymentBase().href,prefix);
  } finally { if(saved)Object.defineProperty(globalThis,'document',saved);else delete globalThis.document; }
  assert.equal(assetUrl('social-graph.bin'),'./social-graph.bin');
});

test('worker runtime resolves relative to its mounted worker without requiring document', async () => {
  const baseURI = `${prefix}feed-filter.worker.js`;
  assert.equal(assetUrl(RUNTIME.mjs,baseURI),`${prefix}${RUNTIME.mjs}`);
  let requested;
  await assert.rejects(loadRuntimeBinary(()=>{}, {baseURI,fetchImpl:async url=>{requested=url;return new Response('',{status:503});}}), /download/);
  assert.equal(requested,`${prefix}${RUNTIME.wasm}`);
});

test('bootstrap transport uses the mounted asset and still verifies the pinned bytes', async () => {
  const bytes = await readFile(new URL(`../${GRAPH_BOOTSTRAP.packagePath}`,import.meta.url));
  let requested;
  const result = await loadGraphBootstrap({baseURI:prefix,fetchImpl:async url=>{requested=url;return new Response(bytes);}});
  assert.equal(requested,`${prefix}social-graph.bin`);
  assert.equal(result.provenance.sha256,GRAPH_BOOTSTRAP.sha256);
});

test('invitation links and cleanup preserve the deployment prefix and never move capabilities into the query', () => {
  for (const base of ['https://market.iris.to/',prefix,`${prefix}index.html?profile=test`]) {
    const link = new URL(invitationBase(base));link.hash='private-capability';
    assert.equal(link.search,'?invite=1');
    assert.equal(link.pathname,new URL('./',base).pathname);
    const captured=captureInvitation(link.href,base);
    assert.equal(captured.invite,link.href);
    assert.equal(captured.cleanURL,new URL('./',base).href);
    assert(!captured.cleanURL.includes('private-capability'));
  }
  const legacy=captureInvitation(`${prefix}invite?preview=1#private-capability`);
  assert.equal(legacy.cleanURL,`${prefix}?preview=1`);
  assert.equal(captureInvitation(`${prefix}#main`),null);
});
