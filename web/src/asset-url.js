/** Own assets stay inside a static deployment directory, including Hashtree mounts. */
export function assetUrl(path, baseURI = globalThis.document?.baseURI ?? globalThis.location?.href) {
  const relative = path.startsWith('./') ? path : `./${path}`;
  return baseURI ? new URL(relative, baseURI).href : relative;
}

export function deploymentBase(baseURI = globalThis.document?.baseURI ?? globalThis.location?.href ?? 'https://market.iris.to/') {
  return new URL('./', baseURI);
}

/** Keep capability data in the fragment and use a file that static hosts already serve. */
export function invitationBase(baseURI) {
  const base = deploymentBase(baseURI);
  base.searchParams.set('invite', '1');
  return base.href;
}

/** Capture legacy /invite and static-directory links without escaping the current mount. */
export function captureInvitation(href, baseURI = href) {
  const incoming = new URL(href), base = deploymentBase(baseURI);
  const legacy = incoming.pathname === new URL('invite', base).pathname;
  if (!incoming.hash || (!legacy && incoming.searchParams.get('invite') !== '1')) return null;
  const clean = new URL(incoming);
  if (legacy) clean.pathname = base.pathname;
  clean.hash = '';
  clean.searchParams.delete('invite');
  return { invite: incoming.href, cleanURL: clean.href };
}
