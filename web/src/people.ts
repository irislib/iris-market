import { minidenticon } from 'minidenticons';
import { imageUrl } from './media.ts';
import { DEFAULT_RELAYS } from './market.ts';
import { readProfileMetadata, watchProfileMetadata, type SocialConnection } from './profiles.ts';
let getRelays = () => DEFAULT_RELAYS, isPreview = () => false, onChange = () => {}, pending = new Set<string>(), attempted = new Map<string,number>(), queued = false, generation = 0;
let relationshipFor: (key:string)=>SocialConnection|undefined = () => undefined, makeRelationshipBadge: (relation:SocialConnection)=>HTMLElement|null = () => null;
const watches = new Set<ReturnType<typeof watchProfileMetadata>>();
interface PeopleOptions { getRelays:()=>string[]; isPreview:()=>boolean; onChange?:()=>void; relationshipFor?:(key:string)=>SocialConnection|undefined; makeRelationshipBadge?:(relation:SocialConnection)=>HTMLElement|null }
export function setupPeople(options:PeopleOptions) { getRelays = options.getRelays; isPreview = options.isPreview; onChange = options.onChange || (() => {}); relationshipFor = options.relationshipFor || (() => undefined); makeRelationshipBadge = options.makeRelationshipBadge || (() => null); }
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
export function createUserRow(key, { onClick, size = 28, className = '' }: {onClick?:(event:MouseEvent)=>void;size?:number;className?:string} = {}) {
  const row = document.createElement(onClick ? 'button' : 'span'); row.className = `user-row ${className}`.trim(); row.dataset.person = key;
  row.append(createAvatar(key, {size}), createUserName(key)); paintRelationship(row);
  if (onClick) { row.onclick = onClick; row.setAttribute('aria-label', `View profile: ${nameFor(key)}`); }
  warmProfiles([key]); return row;
}
export function refreshPeople() {
  for (const image of document.querySelectorAll<HTMLImageElement>('[data-person-avatar]')) paintAvatar(image, personFor(image.dataset.personAvatar));
  for (const label of document.querySelectorAll<HTMLElement>('[data-person-name]')) label.textContent = nameFor(label.dataset.personName);
  for (const row of document.querySelectorAll<HTMLButtonElement>('button[data-person]')) row.setAttribute('aria-label', `View profile: ${nameFor(row.dataset.person)}`);
  for (const row of document.querySelectorAll<HTMLElement>('.user-row[data-person]')) paintRelationship(row);
}
function paintRelationship(row:HTMLElement) {
  for (const previous of row.querySelectorAll('[data-person-relationship]')) previous.remove();
  const relation = relationshipFor(row.dataset.person);
  if (!relation) return;
  const badge = makeRelationshipBadge(relation);
  if (badge) { badge.dataset.personRelationship = ''; row.append(badge); }
}
export function resetPeople() { generation++; pending.clear(); attempted.clear(); queued = false; for (const watch of watches) watch.close(); watches.clear(); }
export function warmProfiles(keys) {
  if (isPreview()) return;
  for (const key of keys) if (/^[0-9a-f]{64}$/.test(key) && Date.now() - (attempted.get(key) || 0) > 300000 && pending.size < 512) pending.add(key);
  schedule();
}
function schedule() {
  if (queued || !pending.size || watches.size >= 8) return;
  queued = true; const run = generation;
  queueMicrotask(() => { if (run !== generation) return; queued = false; drain(run); });
}
function drain(run:number) {
  while (pending.size && watches.size < 8 && generation === run) {
    const batch = [...pending].slice(0, 64);
    for (const key of batch) { pending.delete(key); attempted.set(key, Date.now()); }
    while (attempted.size > 512) attempted.delete(attempted.keys().next().value);
    let watch:ReturnType<typeof watchProfileMetadata>;
    watch = watchProfileMetadata(batch, { relays:getRelays(), onChange() {
      if (generation === run) { refreshPeople(); onChange(); }
    }, onClose() { watches.delete(watch); if (generation === run) schedule(); } });
    watches.add(watch);
  }
}
window.addEventListener('pagehide', resetPeople);
