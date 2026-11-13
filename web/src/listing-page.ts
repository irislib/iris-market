import {flushSync, mount, unmount} from 'svelte';
import Page from './listing-view/Page.svelte';
import type {ListingPageOptions, ListingPresentation} from './listing-view/types.ts';

// Callers own the returned article and replace it with plain DOM calls, so a
// page whose article has been dropped is unmounted on a later render.
const pages = new Map<HTMLElement, ReturnType<typeof mount>>();

export function renderListingPage(listing:ListingPresentation, options:ListingPageOptions):HTMLElement {
  for (const [article, page] of pages) if (!article.isConnected && !article.parentNode) { pages.delete(article); void unmount(page); }
  const host = document.createElement('div');
  const page = mount(Page, {target: host, props: {listing, options}});
  flushSync();
  const article = host.firstElementChild as HTMLElement;
  article.remove();
  pages.set(article, page);
  return article;
}
