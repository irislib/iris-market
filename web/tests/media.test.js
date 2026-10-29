import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { imageUrl, DEFAULT_IMAGE_SETTINGS, readImageSettings, saveImageSettings } from '../src/media.ts';
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
