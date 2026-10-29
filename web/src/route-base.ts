/** Find the app directory without assuming it is hosted at the origin root. */
export function routeBase(href: string): URL {
  const url = new URL(href), parts = url.pathname.split('/');
  const publicId = /^(?:npub1[ac-hj-np-z02-9]{58}|naddr1[ac-hj-np-z02-9]+)$/i;
  const sections = /^(?:post|saved|messages|orders|wallet|settings|courier)$/;
  // Directory mounts keep a trailing slash; public routes deliberately do not.
  if (!url.pathname.endsWith('/')) {
    let index = parts.length - 1;
    if (index > 1 && (publicId.test(parts[index - 1]) || /^(messages|orders|settings)$/.test(parts[index - 1]))) index--;
    if (publicId.test(parts[index]) || sections.test(parts[index])) {
      url.pathname = parts.slice(0, index).join('/') + '/'; url.search = ''; url.hash = ''; return url;
    }
  }
  return new URL('./', url);
}
