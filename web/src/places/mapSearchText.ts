export function normalizeMapSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function mapSearchResultText(result: SearchResult): string {
  return normalizeMapSearchText([
    result.name, result.displayName, result.context, result.type, result.addressType,
    ...(result.aliases ?? []), ...(result.contextParts ?? []), ...(result.contextAliases ?? []),
  ].filter(Boolean).join(' '));
}

export function matchesMapSearchQuery(result: SearchResult, query: string): boolean {
  const words = mapSearchResultText(result).split(' ');
  const terms = normalizeMapSearchText(query).split(' ').filter(Boolean);
  return terms.length > 0 && terms.every(term => words.some(word => word.startsWith(term)));
}
import type { SearchResult } from './types.ts';
