import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createStaticImage, imageUrl, DEFAULT_IMAGE_SETTINGS, readImageSettings, saveImageSettings } from '../src/media.ts';
const memory = () => { let value; return { getItem: () => value, setItem: (key, next) => { value = next; } }; };

test('proxy URLs use the exact Iris HMAC, resize, dpr and unpadded source encoding contract', () => {
  const original = 'https://example.com/image.jpg', key = '11'.repeat(32), salt = '22'.repeat(32), path = `/rs:fit:320:320/dpr:2/${Buffer.from(original).toString('base64url')}`;
  const signature = createHmac('sha256', Buffer.from(key, 'hex')).update(Buffer.from(salt, 'hex')).update(path).digest('base64url');
  assert.equal(imageUrl(original, { width: 320 }, { ...DEFAULT_IMAGE_SETTINGS, url: 'https://img.test', key, salt }), `https://img.test/${signature}${path}`);
});

test('default avatar proxy matches native Iris square resize and signed UTF-8 input', () => {
  const input = 'https://example.com/ä avatar.jpg', path = `/rs:fill:64:64/dpr:2/${Buffer.from(input).toString('base64url')}`;
  const signature = createHmac('sha256', Buffer.from(DEFAULT_IMAGE_SETTINGS.key, 'hex')).update(Buffer.from(DEFAULT_IMAGE_SETTINGS.salt, 'hex')).update(path).digest('base64url');
  assert.equal(imageUrl(input, { width: 64, square: true }), `${DEFAULT_IMAGE_SETTINGS.url}/${signature}${path}`);
  assert.match(imageUrl(input), /\/dpr:2\//);
});

test('local relative images and data/blob images remain local, including large in-memory images', () => {
  for (const input of ['/icon.svg', './photo.png', 'photo.png', 'data:image/png;base64,' + 'a'.repeat(40000), 'blob:https://market.iris.to/generated']) assert.equal(imageUrl(input, { width: 80 }), input);
});

test('protocol-relative remote URLs are proxied and unsafe schemes or credentials never become sources', () => {
  assert.match(imageUrl('//example.com/avatar.jpg'), /^https:\/\/imgproxy\.iris\.to\//);
  for (const input of ['javascript:alert(1)', 'file:///private/photo', 'data:text/html,hello', 'https://user:pass@example.com/image', '\\example.com\\image.jpg', 'htree://unsupported']) assert.equal(imageUrl(input), null);
});

test('only the exact proxy origin and path segment boundary bypass signing', () => {
  const config = { ...DEFAULT_IMAGE_SETTINGS, url: 'https://images.example/proxy' };
  const proxied = 'https://images.example/proxy/signature/dpr:2/source'; assert.equal(imageUrl(proxied, {}, config), proxied);
  for (const input of ['https://images.example/proxy-other/a.jpg', 'https://images.example.attacker.invalid/proxy/a.jpg', 'https://images.example:8443/proxy/a.jpg']) assert.notEqual(imageUrl(input, {}, config), input);
  assert.equal(imageUrl('https://images.example@attacker.invalid/a.jpg', {}, config), null);
});

test('invalid proxy settings fail closed and only an explicit disable permits direct remote loads', () => {
  const input = 'https://example.com/avatar.jpg';
  assert.equal(imageUrl(input, {}, { ...DEFAULT_IMAGE_SETTINGS, key: 'invalid' }), null);
  assert.equal(imageUrl(input, {}, { ...DEFAULT_IMAGE_SETTINGS, url: 'http://proxy.example' }), null);
  assert.equal(imageUrl(input, { width: -20 }), null);
  assert.equal(imageUrl(input, {}, { ...DEFAULT_IMAGE_SETTINGS, useProxy: false }), input);
});

test('settings persist with validation and malformed stored configuration returns secure defaults', () => {
  const storage = memory(); assert.deepEqual(readImageSettings(storage), DEFAULT_IMAGE_SETTINGS);
  const saved = saveImageSettings({ useProxy: false, url: 'https://images.example/proxy/' }, storage); assert.equal(saved.url, 'https://images.example/proxy'); assert.deepEqual(readImageSettings(storage), saved);
  for (const url of ['http://proxy.example', 'https://user:secret@proxy.example', 'https://proxy.example/?token=x']) assert.throws(() => saveImageSettings({ url }, storage), /HTTPS/);
  assert.throws(() => saveImageSettings({ key: 'a' }, storage), /hexadecimal/);
  storage.setItem('', '{broken'); assert.deepEqual(readImageSettings(storage), DEFAULT_IMAGE_SETTINGS);
});

test('static thumbnails sign explicit PNG output for every remote format, retaining transparency', () => {
  const config = { ...DEFAULT_IMAGE_SETTINGS, url: 'https://img.test', key: '11'.repeat(32), salt: '22'.repeat(32) };
  // The server may return animation regardless of a filename or absent suffix.
  for (const original of ['https://example.com/animation.gif', 'https://example.com/transparent.webp', 'https://example.com/looks-static.jpg', 'https://example.com/image?id=123']) {
    const path = `/rs:fit:320:320/dpr:2/f:png/${Buffer.from(original).toString('base64url')}`;
    const signature = createHmac('sha256', Buffer.from(config.key, 'hex')).update(Buffer.from(config.salt, 'hex')).update(path).digest('base64url');
    assert.equal(imageUrl(original, { width: 320, static: true }, config), `${config.url}/${signature}${path}`);
  }
});

test('static requests cannot bypass conversion through untrusted existing proxy or same-origin URLs', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { origin: 'https://market.test' }, configurable: true });
  try {
    const config = { ...DEFAULT_IMAGE_SETTINGS, url: 'https://images.example/proxy' };
    for (const source of ['https://images.example/proxy/untrusted/f:gif/source', 'https://market.test/animation', '//example.com/no-extension']) {
      const result = imageUrl(source, { width: 200, static: true }, config);
      assert(result.startsWith(`${config.url}/`));
      assert(result.includes('/f:png/'));
      assert.equal(Buffer.from(result.split('/').at(-1), 'base64url').toString(), source.startsWith('//') ? `https:${source}` : source);
      assert.notEqual(result, source);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location;
  }
});

test('static mode respects disabled or invalid proxies and never leaks local sources to one', () => {
  const source = 'https://example.com/image';
  assert.equal(imageUrl(source, { static: true }, { ...DEFAULT_IMAGE_SETTINGS, useProxy: false }), null);
  assert.equal(imageUrl(source, { static: true }, { ...DEFAULT_IMAGE_SETTINGS, key: 'invalid' }), null);
  assert.equal(imageUrl(source, { static: true }, { ...DEFAULT_IMAGE_SETTINGS, url: 'http://proxy.example' }), null);
  assert.equal(imageUrl(source, { static: true, width: 9000 }), null);
  for (const local of ['/image.png', './image.webp', 'data:image/png;base64,a', 'blob:https://market.test/private']) {
    assert.equal(imageUrl(local, { static: true }), null);
    assert.equal(imageUrl(local), local, 'normal explicit image display remains compatible');
  }
});


function imageDocument(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document'), nodes = [], draws = [];
  const document = { createElement(tag) {const element = {tagName:tag.toUpperCase(),style:{},attributes:new Map(),setAttribute(key,value){this.attributes.set(key,value);},getContext(){return {drawImage(...args){draws.push(args);}};},toDataURL(){throw Error('No pixel export');},toBlob(){throw Error('No pixel export');}};nodes.push(element);return element;} };
  Object.defineProperty(globalThis,'document',{value:document,configurable:true});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  return {nodes,draws};
}

test('explicit proxy-off loads a direct image once and freezes its aspect ratio without reading pixels',t=>{
  const {nodes,draws}=imageDocument(t),source='https://photos.example/animated.gif';
  const canvas=createStaticImage(source,{width:480,alt:'Oak desk',fallback:'data:image/svg+xml,placeholder'},{...DEFAULT_IMAGE_SETTINGS,useProxy:false});
  assert.equal(canvas.tagName,'CANVAS');assert.equal(canvas.attributes.get('aria-label'),'Oak desk');
  const image=nodes.find(node=>node.tagName==='IMG');assert.equal(image.src,source);assert.equal(image.crossOrigin,undefined);assert.equal(image.referrerPolicy,'no-referrer');
  image.naturalWidth=1600;image.naturalHeight=800;image.onload();
  assert.equal(canvas.width,960);assert.equal(canvas.height,480);assert.equal(draws.length,1);assert.equal(image.onload,null);assert.equal(image.onerror,null);
});

test('direct-load failures draw the placeholder and invalid/proxy-enabled settings never request the origin',t=>{
  const {nodes,draws}=imageDocument(t),source='https://photos.example/image.gif',fallback='data:image/svg+xml,placeholder';
  const canvas=createStaticImage(source,{width:480,fallback},{...DEFAULT_IMAGE_SETTINGS,useProxy:false});
  const direct=nodes.find(node=>node.tagName==='IMG');direct.onerror();assert.equal(direct.src,fallback);
  direct.naturalWidth=360;direct.naturalHeight=300;direct.onload();assert.equal(draws.length,1);assert.equal(canvas.width,360);
  const invalid=createStaticImage(source,{width:480,fallback},{...DEFAULT_IMAGE_SETTINGS,useProxy:false,key:'invalid'});
  assert.equal(invalid.tagName,'IMG');assert.equal(invalid.src,fallback);
  const proxied=createStaticImage(source,{width:480,fallback});assert.equal(proxied.tagName,'IMG');assert.match(proxied.src,/\/f:png\//);
  proxied.onerror();assert.match(proxied.src,/rs:fit:512:512/);proxied.onerror();assert.equal(proxied.src,fallback);
});
