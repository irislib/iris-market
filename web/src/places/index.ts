// Adapted from Iris Maps, MIT; see SOURCE.md. Account/worker stores are deliberately excluded.
import {createAsyncCache} from './asyncCache.ts';
import {normalizeMapSearchText as normalizeSearchText,matchesMapSearchQuery} from './mapSearchText.ts';
import {HashTree,fromHex,toHex,type CID,type Hash,type Store} from '@hashtree/core';
import {SearchIndex,type SearchIndexOptions} from '@hashtree/index';
import type {SearchAddressPoint,SearchAddressRef,SearchAddressSidecar,SearchResult} from './types.ts';
const textDecoder=new TextDecoder();
export interface MapPlaceSearchSource {manifest:MapPlaceSearchManifest;search(query:string,limit?:number):Promise<SearchResult[]>;resolveAddress(street:SearchResult,houseNumber:string,limit?:number):Promise<SearchResult[]>;}
export const DEFAULT_MAP_SEARCH_PREFIX='p:';
export const MAP_SEARCH_TIMEOUT_MS=5000;
export interface SerializedCid {
  hash: string;
  key?: string;
}

export interface MapPlaceSearchManifest {
  version: number;
  kind: 'iris-maps-place-search-index';
  generatedAt?: string;
  source?: string;
  placeCount: number;
  searchIndexVersion: number;
  prefix: string;
  searchRoot: SerializedCid | null;
  byIdRoot?: SerializedCid | null;
  searchOptions?: SearchIndexOptions;
  locationContext?: { scopePrefix: string; source?: string; release?: string };
  /** Name/alias postings for settlements and administrative areas, sharing record CIDs with p:. */
  placeNames?: { version: 1; prefix: 'n:' };
  recordPacking?: {
    kind: 'json-record-shard';
    version?: number;
    maxRecordsPerShard?: number;
  };
  addressSidecars?: {
    kind: 'street-address-points-v1';
    sourceLayer?: string;
    streetLayer?: string;
    sourceZoom?: number;
    joinRadiusMeters?: number;
    sidecarCount?: number;
    pointCount?: number;
    runCount?: number;
  };
}

export function deserializeCid(value: SerializedCid | null | undefined): CID | null {
  if (!value?.hash) return null;
  return {
    hash: fromHex(value.hash),
    ...(value.key ? { key: fromHex(value.key) } : {}),
  };
}

function cidCacheKey(cid: CID): string {
  return `${toHex(cid.hash)}:${cid.key ? toHex(cid.key) : ''}`;
}

function extractSingleCharacterTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const rawWord of `${text ?? ''}`.split(/[^\p{L}\p{N}]+/u)) {
    const normalized = normalizeSearchText(rawWord);
    if (normalized.length === 1 && !/^\d$/u.test(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      terms.push(normalized);
    }
  }
  return terms;
}

export function buildMapSearchTerms(searchIndex: Pick<SearchIndex, 'parseKeywords'>, text: string): string[] {
  const terms = searchIndex.parseKeywords(text);
  const seen = new Set(terms);
  for (const singleCharacterTerm of extractSingleCharacterTerms(text)) {
    if (!seen.has(singleCharacterTerm)) {
      seen.add(singleCharacterTerm);
      terms.push(singleCharacterTerm);
    }
  }
  return terms;
}

export function normalizeHouseNumber(value: string): string {
  return `${value ?? ''}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, '')
    .trim();
}

function parseHouseNumberNumber(value: string): number | null {
  const match = normalizeHouseNumber(value).match(/^(\d+)/u);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function houseNumberMatches(candidate: string, query: string): boolean {
  const normalizedCandidate = normalizeHouseNumber(candidate);
  const normalizedQuery = normalizeHouseNumber(query);
  if (!normalizedCandidate || !normalizedQuery) return false;
  if (normalizedCandidate === normalizedQuery) return true;

  const rangeMatch = normalizedCandidate.match(/^(\d+)[a-z]?-(\d+)[a-z]?$/u);
  const queryNumber = parseHouseNumberNumber(normalizedQuery);
  if (!rangeMatch || queryNumber === null) return false;

  const from = Number.parseInt(rangeMatch[1], 10);
  const to = Number.parseInt(rangeMatch[2], 10);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  const min = Math.min(from, to);
  const max = Math.max(from, to);
  return queryNumber >= min && queryNumber <= max;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeSearchResult(value: unknown): SearchResult | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<SearchResult>;
  if (typeof record.name !== 'string' || !record.name.trim()) return null;
  if (!isFiniteNumber(record.lat) || !isFiniteNumber(record.lng)) return null;
  if (typeof record.type !== 'string' || !record.type.trim()) return null;
  if (typeof record.class !== 'string' || !record.class.trim()) return null;

  const result: SearchResult = {
    name: record.name.trim(),
    displayName: typeof record.displayName === 'string' && record.displayName.trim()
      ? record.displayName.trim()
      : record.name.trim(),
    lat: record.lat,
    lng: record.lng,
    type: record.type.trim(),
    class: record.class.trim(),
  };
  if (typeof record.id === 'string' && record.id.trim()) {
    result.id = record.id.trim();
  }
  if (typeof record.context === 'string' && record.context.trim()) {
    result.context = record.context.trim();
  }
  if (Array.isArray(record.contextParts)) {
    const contextParts = record.contextParts
      .filter((part): part is string => typeof part === 'string' && !!part.trim())
      .map((part) => part.trim())
      .slice(0, 8);
    if (contextParts.length > 0) result.contextParts = contextParts;
  }
  if (Array.isArray(record.contextAliases)) {
    result.contextAliases = record.contextAliases
      .filter((alias): alias is string => typeof alias === 'string' && !!alias.trim())
      .map(alias => alias.trim()).slice(0, 24);
  }
  if (Array.isArray(record.aliases)) {
    const aliases = record.aliases
      .filter((alias): alias is string => typeof alias === 'string' && !!alias.trim())
      .map((alias) => alias.trim())
      .slice(0, 24);
    if (aliases.length > 0) result.aliases = aliases;
  }
  if (Array.isArray(record.boundingBox) && record.boundingBox.length === 4 && record.boundingBox.every(isFiniteNumber)) {
    result.boundingBox = record.boundingBox as [number, number, number, number];
  }
  if (isFiniteNumber(record.importance)) result.importance = record.importance;
  if (isFiniteNumber(record.placeRank)) result.placeRank = record.placeRank;
  if (typeof record.addressType === 'string' && record.addressType.trim()) {
    result.addressType = record.addressType.trim();
  }
  if (typeof record.sourceLayer === 'string' && record.sourceLayer.trim()) {
    result.sourceLayer = record.sourceLayer.trim();
  }
  if (isFiniteNumber(record.sourceZoom)) result.sourceZoom = record.sourceZoom;
  if (typeof record.sourceId === 'string' && record.sourceId.trim()) {
    result.sourceId = record.sourceId.trim();
  }
  if (Array.isArray(record.sourceTile) && record.sourceTile.length === 2 && record.sourceTile.every(isFiniteNumber)) {
    result.sourceTile = record.sourceTile as [number, number];
  }
  const addressRef = normalizeAddressRef(record.addressRef);
  if (addressRef) result.addressRef = addressRef;
  return result;
}

function normalizeAddressRef(value: unknown): SearchAddressRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const ref = value as Partial<SearchAddressRef>;
  if (ref.kind !== 'street-address-points-v1') return undefined;
  if (!ref.cid || typeof ref.cid !== 'object' || typeof ref.cid.hash !== 'string' || !ref.cid.hash.trim()) {
    return undefined;
  }
  const normalized: SearchAddressRef = {
    kind: 'street-address-points-v1',
    cid: {
      hash: ref.cid.hash.trim(),
      ...(typeof ref.cid.key === 'string' && ref.cid.key.trim() ? { key: ref.cid.key.trim() } : {}),
    },
  };
  if (isFiniteNumber(ref.count)) normalized.count = ref.count;
  if (isFiniteNumber(ref.maxDistanceMeters)) normalized.maxDistanceMeters = ref.maxDistanceMeters;
  return normalized;
}

function normalizeAddressPoint(value: unknown): SearchAddressPoint | null {
  if (!value || typeof value !== 'object') return null;
  const point = value as Partial<SearchAddressPoint>;
  if (typeof point.n !== 'string' || !point.n.trim()) return null;
  if (!isFiniteNumber(point.lat) || !isFiniteNumber(point.lng)) return null;
  const normalized: SearchAddressPoint = {
    n: point.n.trim(),
    lat: point.lat,
    lng: point.lng,
  };
  if (isFiniteNumber(point.confidence)) normalized.confidence = point.confidence;
  if (isFiniteNumber(point.distanceMeters)) normalized.distanceMeters = point.distanceMeters;
  if (isFiniteNumber(point.sourceZoom)) normalized.sourceZoom = point.sourceZoom;
  if (Array.isArray(point.sourceTile) && point.sourceTile.length === 2 && point.sourceTile.every(isFiniteNumber)) {
    normalized.sourceTile = point.sourceTile as [number, number];
  }
  return normalized;
}

function normalizeAddressSidecar(value: unknown): SearchAddressSidecar | null {
  if (!value || typeof value !== 'object') return null;
  const sidecar = value as Partial<SearchAddressSidecar>;
  if (sidecar.kind !== 'iris-maps-street-address-sidecar' || !Array.isArray(sidecar.points)) return null;
  const points = sidecar.points
    .map(normalizeAddressPoint)
    .filter((point): point is SearchAddressPoint => point !== null);
  return {
    version: typeof sidecar.version === 'number' ? sidecar.version : 1,
    kind: 'iris-maps-street-address-sidecar',
    ...(typeof sidecar.streetId === 'string' && sidecar.streetId.trim() ? { streetId: sidecar.streetId.trim() } : {}),
    points,
  };
}

function addressMatchScore(point: SearchAddressPoint, query: string): number {
  if (normalizeHouseNumber(point.n) === normalizeHouseNumber(query)) return 2;
  return houseNumberMatches(point.n, query) ? 1 : 0;
}

function addressPointToSearchResult(street: SearchResult, point: SearchAddressPoint): SearchResult {
  const addressName = `${street.name} ${point.n}`.trim();
  const streetKey = street.id
    ?? `${street.name.toLowerCase()}-${street.lat.toFixed(5)}-${street.lng.toFixed(5)}`;
  const aliases = [
    `${point.n} ${street.name}`.trim(),
    ...(street.aliases ?? []).map((alias) => `${alias} ${point.n}`.trim()),
    ...(street.aliases ?? []).map((alias) => `${point.n} ${alias}`.trim()),
  ].filter((alias, index, list) => alias && list.indexOf(alias) === index).slice(0, 12);

  return {
    id: `${streetKey}:address:${normalizeHouseNumber(point.n)}:${point.lat.toFixed(6)}:${point.lng.toFixed(6)}`,
    name: addressName,
    lat: point.lat,
    lng: point.lng,
    type: 'house',
    class: 'building',
    displayName: 'Address',
    context: street.context,
    contextParts: street.contextParts,
    contextAliases: street.contextAliases,
    aliases,
    placeRank: 30,
    importance: Math.min(1, Math.max(0.05, (street.importance ?? 0.2) + ((point.confidence ?? 0.5) * 0.05))),
    addressType: 'house',
    sourceLayer: 'housenumber',
    sourceZoom: point.sourceZoom ?? street.sourceZoom,
    sourceId: street.sourceId,
    sourceTile: point.sourceTile ?? street.sourceTile,
  };
}

function normalizePlaceNames(value: unknown): MapPlaceSearchManifest['placeNames'] {
  if (!value || typeof value !== 'object') return undefined;
  const capability = value as Partial<NonNullable<MapPlaceSearchManifest['placeNames']>>;
  return capability.version === 1 && capability.prefix === 'n:' ? { version: 1, prefix: 'n:' } : undefined;
}

export async function fetchMapPlaceSearchManifest(url: string): Promise<MapPlaceSearchManifest> {
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(MAP_SEARCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Failed to load map search index manifest: ${response.status}`);
  }
  const manifest = await response.json() as Partial<MapPlaceSearchManifest>;
  if (
    manifest.kind !== 'iris-maps-place-search-index'
    || typeof manifest.version !== 'number'
    || typeof manifest.placeCount !== 'number'
    || typeof manifest.searchIndexVersion !== 'number'
    || typeof manifest.prefix !== 'string'
  ) {
    throw new Error('Invalid map search index manifest');
  }
  return {
    version: manifest.version,
    kind: manifest.kind,
    generatedAt: manifest.generatedAt,
    source: manifest.source,
    placeCount: manifest.placeCount,
    searchIndexVersion: manifest.searchIndexVersion,
    prefix: manifest.prefix || DEFAULT_MAP_SEARCH_PREFIX,
    searchRoot: manifest.searchRoot ?? null,
    byIdRoot: manifest.byIdRoot ?? null,
    searchOptions: manifest.searchOptions,
    locationContext: manifest.locationContext?.scopePrefix === 'g:' ? manifest.locationContext : undefined,
    placeNames: normalizePlaceNames(manifest.placeNames),
    recordPacking: manifest.recordPacking?.kind === 'json-record-shard'
      ? {
          kind: 'json-record-shard',
          version: manifest.recordPacking.version,
          maxRecordsPerShard: manifest.recordPacking.maxRecordsPerShard,
        }
      : undefined,
    addressSidecars: manifest.addressSidecars?.kind === 'street-address-points-v1'
      ? {
          kind: 'street-address-points-v1',
          sourceLayer: manifest.addressSidecars.sourceLayer,
          streetLayer: manifest.addressSidecars.streetLayer,
          sourceZoom: manifest.addressSidecars.sourceZoom,
          joinRadiusMeters: manifest.addressSidecars.joinRadiusMeters,
          sidecarCount: manifest.addressSidecars.sidecarCount,
          pointCount: manifest.addressSidecars.pointCount,
          runCount: manifest.addressSidecars.runCount,
        }
      : undefined,
  };
}

export function createMapPlaceSearchSource(
  manifest: MapPlaceSearchManifest,
  options: {
    store: Store;
    tree?: Pick<HashTree, 'readFile'>;
  },
): MapPlaceSearchSource {
  // The index library logs and swallows individual term-read errors. Retain the
  // failure signal so an unsuccessful scan cannot masquerade as an empty catalog.
  let readFailures = 0;
  let lastReadFailure: unknown;
  const store: Store = {
    has: hash => options.store.has(hash),
    put: (hash, data) => options.store.put(hash, data),
    delete: hash => options.store.delete(hash),
    async get(hash) {
      try {
        const block = await options.store.get(hash);
        if (!block) throw new Error('Place catalog block unavailable');
        return block;
      } catch (error) { readFailures++; lastReadFailure = error; throw error; }
    },
  };
  const tree = options.tree ?? new HashTree({ store });
  const searchIndex = new SearchIndex(store, manifest.searchOptions ?? { order: 64, minKeywordLength: 1 });
  const searchRoot = deserializeCid(manifest.searchRoot);
  const placeNamesPrefix = normalizePlaceNames(manifest.placeNames)?.prefix;
  async function readJson(cid: CID): Promise<unknown> {
    const data = await tree.readFile(cid);
    if (!data) throw new Error('Place catalog record unavailable');
    return JSON.parse(textDecoder.decode(data));
  }

  const readRecord = createAsyncCache(async (cid: CID) => normalizeSearchResult(await readJson(cid)), cidCacheKey);
  const readAddressSidecar = createAsyncCache(async (cid: CID) => normalizeAddressSidecar(await readJson(cid)), cidCacheKey);
  const readRecordShard = createAsyncCache(async (cid: CID) => {
    const shard = await readJson(cid) as { records?: unknown[] } | null;
    if (!shard) return null;
    const records = new Map<string, SearchResult>();
    for (const entry of shard.records ?? []) {
      const normalized = normalizeSearchResult(entry);
      if (normalized?.id) records.set(normalized.id, normalized);
    }
    return records;
  }, cidCacheKey);

  async function readLinkRecord(link: { cid: CID; id?: string }): Promise<SearchResult | null> {
    if (manifest.recordPacking?.kind !== 'json-record-shard') {
      return await readRecord(link.cid);
    }
    if (!link.id) return null;
    const shard = await readRecordShard(link.cid);
    return shard?.get(link.id) ?? null;
  }

  return {
    manifest,
    async search(query: string, limit = 40): Promise<SearchResult[]> {
      if (!searchRoot || limit <= 0) return [];
      async function lookup(text: string, prefix: string): Promise<SearchResult[]> {
        const failuresBefore = readFailures;
        const terms = buildMapSearchTerms(searchIndex, text);
        if (!terms.length) return [];
        const candidateLimit = Math.max(limit, 24);
        const prefixes = placeNamesPrefix ? [placeNamesPrefix, prefix] : [prefix];
        const batches = await Promise.all(prefixes.map(prefix => searchIndex.searchLinkTerms(searchRoot, prefix, terms, {
          limit: candidateLimit, scanLimit: candidateLimit,
        })));
        if (!batches.some(batch => batch.length) && readFailures !== failuresBefore) throw lastReadFailure;
        // Reserve candidates from the name namespace before ordinary matches can fill
        // the result limit. Deduplicate by record ID, never by the shared shard CID.
        const links = new Map(batches.flat().map(link => [link.id, link]));
        const records = await Promise.all([...links.values()].map(link => readLinkRecord(link)));
        const results = records.filter((record): record is SearchResult => record !== null && matchesMapSearchQuery(record, query)).slice(0, limit);
        if (!results.length && readFailures !== failuresBefore) throw lastReadFailure;
        return results;
      }
      const scopedPrefix = manifest.locationContext?.scopePrefix;
      const parts = query.split(',').map(normalizeSearchText).filter(Boolean);
      if (scopedPrefix && parts.length > 1) {
        const scoped = await lookup(parts[0], `${scopedPrefix}${parts[1]}:`);
        if (scoped.length) return scoped;
      }
      const primary = await lookup(query, manifest.prefix || DEFAULT_MAP_SEARCH_PREFIX);
      if (primary.length || !scopedPrefix || parts.length > 1) return primary;
      // Support "Main Street Espoo" even when the global name scan fills up
      // before reaching this city. Bound the number of location interpretations.
      const words = normalizeSearchText(query).split(' ');
      for (let size = 1; size < words.length && size <= 3; size += 1) {
        const scoped = await lookup(words.slice(0, -size).join(' '), `${scopedPrefix}${words.slice(-size).join(' ')}:`);
        if (scoped.length) return scoped;
      }
      return [];
    },
    async resolveAddress(street: SearchResult, houseNumber: string, limit = 8): Promise<SearchResult[]> {
      if (!street.addressRef || !houseNumber.trim()) return [];
      const cid = deserializeCid(street.addressRef.cid);
      const sidecar = cid ? await readAddressSidecar(cid) : null;
      if (!sidecar?.points.length) return [];

      return sidecar.points
        .map((point) => ({ point, score: addressMatchScore(point, houseNumber) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          const confidenceDelta = (right.point.confidence ?? 0) - (left.point.confidence ?? 0);
          if (confidenceDelta !== 0) return confidenceDelta;
          return (left.point.distanceMeters ?? Number.POSITIVE_INFINITY)
            - (right.point.distanceMeters ?? Number.POSITIVE_INFINITY);
        })
        .slice(0, limit)
        .map(({ point }) => addressPointToSearchResult(street, point));
    },
  };
}
