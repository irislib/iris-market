import type { Event, EventTemplate, Filter } from 'nostr-tools'
import type { RuntimeQueryOptions } from 'nostr-pubsub'
import type { MarketListing } from '../market.ts'

export interface PanelOptions {
  author: string
  host: HTMLElement
  preview: boolean
  account: () => { owner?: string; canSign: boolean; pending?: Event[] }
  onAccountChange: (listener: () => void) => () => void
  connectSigner: () => void
  listings: () => Iterable<MarketListing>
  loadLocalListings: () => Promise<Event[]>
  cacheListing: (event: Event) => void
  sellerName: (author: string) => string
  isSaved: (id: string) => boolean
  isHidden: (id: string) => boolean
  makeCard: (listing: MarketListing) => HTMLElement
  query: (filters: Filter[], options: RuntimeQueryOptions) => ReturnType<import('../nostr-runtime.ts').PublicEventRuntime['query']>
  publish: (draft: EventTemplate, previousId: string | null) => Promise<{event: Event; delivery: 'queued' | 'published'}>
}
