// Subtle monochrome silhouettes on the theme's neutral photo surface.
const paths = {
  product: 'M3 3h7.6a2 2 0 0 1 1.42.59l9.39 9.39a2 2 0 0 1 0 2.83l-5.6 5.6a2 2 0 0 1-2.83 0l-9.39-9.39A2 2 0 0 1 3 10.6ZM7 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z',
  service: 'M9 3h6a2 2 0 0 1 2 2v2h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3V5a2 2 0 0 1 2-2Zm0 4h6V5H9Zm1 5v3h4v-3Z',
};
const silhouettes = Object.fromEntries(Object.entries(paths).map(([kind, path]) => [kind, 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="300" viewBox="0 0 360 300"><path transform="translate(144 114) scale(3)" fill="#808080" opacity=".2" fill-rule="evenodd" d="${path}"/></svg>`)]));
const serviceCategories = new Set(['service', 'services', 'help', 'skills', 'jobs', 'delivery', 'errands']);
export function art(listing: {category?:string} = {}) { return silhouettes[serviceCategories.has(String(listing.category ?? '').trim().toLowerCase()) ? 'service' : 'product']; }
