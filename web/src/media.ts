/*! Adapted from IrisClient src/shared/utils/imgproxy.ts, commit 686134807fd1da128538c582772bcc1c8000d6a0.
 * MIT License, Copyright (c) 2024 Martti Malmi. Full notice: web/licenses/IRIS-CLIENT-LICENSE.txt.
 * Proxy origin/path matching also follows IrisChatRS acaf6062e5c56da6aac28d8284d8c3fff9d0ff79.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js';

export interface ImageSettings { useProxy: boolean; url: string; key: string; salt: string }
export interface ImageDimensions { width?: number; height?: number; square?: boolean }
type ImageStorage = Pick<Storage, 'getItem' | 'setItem'>;

// Public imgproxy signing configuration distributed by the existing Iris clients.
export const DEFAULT_IMAGE_SETTINGS = Object.freeze({
  useProxy: true,
  url: 'https://imgproxy.iris.to',
  key: 'f66233cb160ea07078ff28099bfa3e3e654bc10aa4a745e12176c433d79b8996',
  salt: '5e608e60945dcd2a787e8465d76ba34149894765061d39287609fb9d776caa0c',
});
const STORAGE_KEY = 'iris-market-image-settings';
const encoder = new TextEncoder();
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function normalizeSettings(input: Partial<ImageSettings> = {}): ImageSettings {
  const config = { ...DEFAULT_IMAGE_SETTINGS, ...input };
  if (typeof config.useProxy !== 'boolean') throw new Error('Choose whether to use the image proxy.');
  let url; try { url = new URL(config.url.trim() || DEFAULT_IMAGE_SETTINGS.url); } catch { throw new Error('Enter a valid HTTPS image proxy address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS image proxy address without credentials, a query or a fragment.');
  const normalizeHex = (value, fallback) => { const normalized = String(value || fallback).trim(); if (!/^(?:[0-9a-f]{2}){1,128}$/i.test(normalized)) throw new Error('Proxy key and salt must contain hexadecimal pairs.'); return normalized.toLowerCase(); };
  return { useProxy: config.useProxy, url: url.href.replace(/\/+$/, ''), key: normalizeHex(config.key, DEFAULT_IMAGE_SETTINGS.key), salt: normalizeHex(config.salt, DEFAULT_IMAGE_SETTINGS.salt) };
}
export function readImageSettings(storage?: ImageStorage): ImageSettings {
  try { const value = (storage || (typeof window !== 'undefined' ? window.localStorage : undefined))?.getItem(STORAGE_KEY); return normalizeSettings(value ? JSON.parse(value) : {}); }
  catch { return { ...DEFAULT_IMAGE_SETTINGS }; }
}
export function saveImageSettings(input: Partial<ImageSettings>, storage?: ImageStorage) {
  const config = normalizeSettings(input);
  try { (storage || (typeof window !== 'undefined' ? window.localStorage : undefined)).setItem(STORAGE_KEY, JSON.stringify(config)); }
  catch { throw new Error('Could not save image settings in this browser.'); }
  return config;
}

/** One permitted image source. Failures never reveal the original host as an automatic fallback. */
export function imageUrl(source: string, { width, height, square = false }: ImageDimensions = {}, config = readImageSettings()) {
  if (typeof source !== 'string' || !source.trim()) return null;
  const original = source.trim();
  if (original.startsWith('data:image/') || original.startsWith('blob:')) return original;
  if (original.length > 32_768) return null;
  if (original.includes('\\')) return null;
  if (!original.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(original)) return original;
  let remote, proxy;
  try {
    remote = new URL(original.startsWith('//') ? `https:${original}` : original);
    if (!['http:', 'https:'].includes(remote.protocol) || remote.username || remote.password) return null;
    if (globalThis.location?.origin === remote.origin) return original;
    config = normalizeSettings(config);
    if (!config.useProxy) return remote.href;
    proxy = new URL(config.url);
    const prefix = proxy.pathname.replace(/\/+$/, '');
    if (remote.origin === proxy.origin && (remote.pathname === prefix || remote.pathname.startsWith(prefix + '/'))) return original;
    const dimensions = [width || height, height || width];
    if (dimensions.some(value => value !== undefined && (!Number.isInteger(value) || value < 1 || value > 8192))) return null;
    const resize = dimensions[0] ? `rs:${square ? 'fill' : 'fit'}:${dimensions[0]}:${dimensions[1]}/` : '';
    const path = `/${resize}dpr:2/${base64url(encoder.encode(original.startsWith('//') ? remote.href : original))}`;
    const signature = base64url(hmac(sha256, hexToBytes(config.key), concatBytes(hexToBytes(config.salt), encoder.encode(path))));
    return `${config.url}/${signature}${path}`;
  } catch { return null; }
}
