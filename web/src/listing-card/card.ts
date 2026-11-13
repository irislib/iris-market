import {mount, unmount} from 'svelte'
import type {formatPrice} from '../currency.ts'
import Card from './Card.svelte'

export interface CardContext {
  saved(id: string): boolean
  hidden(id: string): boolean
  preview(): boolean
  href(listing: any): string
  open(listing: any): void
  save(listing: any): void
  toggleHidden(listing: any): void
  quote(listing: any): string | undefined
  price(listing: any): ReturnType<typeof formatPrice>
  photo(listing: any): HTMLElement
  author(listing: any): HTMLElement
}

const mounted = new WeakMap<Element, ReturnType<typeof mount>>()

/** A listing card element for grids that place and recycle cards themselves. */
export function createCard(listing: any, ctx: CardContext): HTMLElement {
  const host = document.createElement('div')
  const component = mount(Card, {target: host, props: {listing, ctx}})
  const card = host.firstElementChild as HTMLElement
  mounted.set(card, component)
  return card
}

/** Release a card's component once a grid drops it. */
export function disposeCard(card: Element) {
  const component = mounted.get(card)
  if (!component) return
  mounted.delete(card)
  void unmount(component)
}
