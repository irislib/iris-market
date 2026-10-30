export interface SearchResult {
  id?: string;
  name: string;
  lat: number;
  lng: number;
  type: string;
  class: string;
  displayName: string;
  context?: string;
  contextParts?: string[];
  contextAliases?: string[];
  aliases?: string[];
  boundingBox?: [number, number, number, number];
  placeRank?: number;
  importance?: number;
  addressType?: string;
  sourceLayer?: string;
  sourceZoom?: number;
  sourceId?: string;
  sourceTile?: [number, number];
  addressRef?: SearchAddressRef;
}

export interface SearchAddressRef {
  kind: 'street-address-points-v1';
  cid: {
    hash: string;
    key?: string;
  };
  count?: number;
  maxDistanceMeters?: number;
}

export interface SearchAddressPoint {
  n: string;
  lat: number;
  lng: number;
  confidence?: number;
  distanceMeters?: number;
  sourceZoom?: number;
  sourceTile?: [number, number];
}

export interface SearchAddressSidecar {
  version: number;
  kind: 'iris-maps-street-address-sidecar';
  streetId?: string;
  points: SearchAddressPoint[];
}
