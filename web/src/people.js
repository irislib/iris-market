import { minidenticon } from 'minidenticons';
import { imageUrl } from './media.js';
import { DEFAULT_RELAYS } from './market.js';
import { readProfileMetadata, loadProfileMetadata } from './profiles.js';
let getRelays = () => DEFAULT_RELAYS, isPreview = () => false, onChange = () => {}, pending = new Set(), attempted = new Map(), running = false, generation = 0, controller;
export function setupPeople(options) { getRelays = options.getRelays; isPreview = options.isPreview; onChange = options.onChange || (() => {}); }
export const personFor = key => readProfileMetadata(key, { relays: getRelays() });
export const nameFor = key => personFor(key).name;
const identicon = key => `data:image/svg+xml,${encodeURIComponent(minidenticon(key, 65, 55))}`;
function paintAvatar(image, person) {
  const fallback = identicon(person.pubkey), source = imageUrl(person.pictureUrl, { width: image.width || 28, square: true }) || fallback;
  if (image.dataset.source === source) return;
  image.dataset.source = source; image.src = source;
  image.onerror = () => { image.onerror = null; image.src = fallback; };
}
export function createAvatar(key, { size = 28 } = {}) {
  const image = document.createElement('img'); image.className = 'user-avatar'; image.dataset.personAvatar = key;
  image.width = size; image.height = size; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
  paintAvatar(image, personFor(key)); return image;
}
export function createUserName(key) {
  const label = document.createElement('span'); label.className = 'user-name'; label.dataset.personName = key; label.textContent = nameFor(key); return label;
}
export function createUserRow(key, { onClick, size = 28, className = '' } = {}) {
  const row = document.createElement(onClick ? 'button' : 'span'); row.className = `user-row ${className}`.trim(); row.dataset.person = key;
  row.append(createAvatar(key, {size}), createUserName(key));
  if (onClick) { row.onclick = onClick; row.setAttribute('aria-label', `View profile: ${nameFor(key)}`); }
  warmProfiles([key]); return row;
}
export function refreshPeople() {
  for (const image of document.querySelectorAll('[data-person-avatar]')) paintAvatar(image, personFor(image.dataset.personAvatar));
  for (const label of document.querySelectorAll('[data-person-name]')) label.textContent = nameFor(label.dataset.personName);
  for (const row of document.querySelectorAll('button[data-person]')) row.setAttribute('aria-label', `View profile: ${nameFor(row.dataset.person)}`);
}
export function resetPeople() { generation++; controller?.abort(); pending.clear(); attempted.clear(); running = false; }
export function warmProfiles(keys) {
  if (isPreview()) return;
  for (const key of keys) if (/^[0-9a-f]{64}$/.test(key) && Date.now() - (attempted.get(key) || 0) > 300000 && pending.size < 512) pending.add(key);
  if (!running && pending.size) { running = true; queueMicrotask(drain); }
}
async function drain() {
  const run = generation; controller = new AbortController();
  try {
    while (pending.size && generation === run) {
      const batch = [...pending].slice(0, 64);
      for (const key of batch) { pending.delete(key); attempted.set(key, Date.now()); }
      while (attempted.size > 512) attempted.delete(attempted.keys().next().value);
      try { await loadProfileMetadata(batch, { relays: getRelays(), signal: controller.signal }); if (generation === run) { refreshPeople(); onChange(); } }
      catch (error) { if (error.name === 'AbortError') return; }
    }
  } finally { if (generation === run) running = false; }
}
window.addEventListener('pagehide', resetPeople);
