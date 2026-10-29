// Subtle monochrome silhouettes on the theme's neutral photo surface.
const paths = {
  product: 'M8 7V6a4 4 0 0 1 8 0v1h3l1 14H4L5 7Zm2 0h4V6a2 2 0 0 0-4 0Z',
  service: 'M9 3h6a2 2 0 0 1 2 2v2h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3V5a2 2 0 0 1 2-2Zm0 4h6V5H9Zm1 5v3h4v-3Z',
};
const silhouettes = Object.fromEntries(Object.entries(paths).map(([kind, path]) => [kind, 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="300" viewBox="0 0 360 300"><path transform="translate(144 114) scale(3)" fill="#808080" opacity=".2" fill-rule="evenodd" d="${path}"/></svg>`)]));
const serviceCategories = new Set(['service', 'services', 'help', 'skills', 'jobs', 'delivery', 'errands']);
export function art(listing: {category?:string} = {}) { return silhouettes[serviceCategories.has(String(listing.category ?? '').trim().toLowerCase()) ? 'service' : 'product']; }
