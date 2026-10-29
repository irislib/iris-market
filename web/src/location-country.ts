/** Approximate country selection only. Coordinates never leave this module. */
export type CountryCoordinates = readonly [longitude: number, latitude: number];
export interface CountryLookupOptions { accuracyMeters?: number }
type Ring = readonly CountryCoordinates[];
type Polygon = readonly Ring[];
export interface CountryBoundaryData {
  version: 1;
  countries: readonly (readonly [code: string | null, polygons: readonly Polygon[]])[];
}
interface PreparedPolygon {
  code: string | null;
  rings: CountryCoordinates[][];
  west: number; south: number; east: number; north: number;
}
export type CountryLookup = (coordinates: CountryCoordinates, options?: CountryLookupOptions) => string | null;

// 50m cartography is approximate, not an address or legal-boundary service.
// Keep a small guard beyond GPS uncertainty and the 4-decimal data rounding.
export const COUNTRY_BOUNDARY_GUARD_METERS = 250;
const METERS_PER_DEGREE = Math.PI * 6_371_008.8 / 180;

function validPosition(value: CountryCoordinates): boolean {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) < 90;
}

/** Unwrap whole rings, rather than each vertex relative to the query point. */
function unwrap(ring: Ring, reference?: number): CountryCoordinates[] {
  const result: CountryCoordinates[] = [];
  let previous = reference ?? ring[0][0];
  for (const [longitude, latitude] of ring) {
    const x = longitude + 360 * Math.round((previous - longitude) / 360);
    result.push([x, latitude]); previous = x;
  }
  return result;
}

function ringRelation(ring: Ring, x: number, y: number, guard: number): 'inside' | 'outside' | 'boundary' {
  let inside = false;
  const scaleX = METERS_PER_DEGREE * Math.cos(y * Math.PI / 180);
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
    const dx = (bx - ax) * scaleX, dy = (by - ay) * METERS_PER_DEGREE;
    const px = (x - ax) * scaleX, py = (y - ay) * METERS_PER_DEGREE;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0;
    if (Math.hypot(px - t * dx, py - t * dy) <= guard) return 'boundary';
    if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

/** Pure lookup factory also accepts small fixtures for hole/date-line tests. */
export function createCountryLookup(data: CountryBoundaryData): CountryLookup {
  if (data.version !== 1 || !Array.isArray(data.countries) || data.countries.length > 300) throw new Error('Unsupported country boundaries');
  const prepared: PreparedPolygon[] = [];
  for (const [code, polygons] of data.countries) for (const polygon of polygons) {
    if (!polygon.length) continue;
    const exterior = unwrap(polygon[0]);
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const [x, y] of exterior) { west = Math.min(west, x); east = Math.max(east, x); south = Math.min(south, y); north = Math.max(north, y); }
    const center = (west + east) / 2;
    prepared.push({ code, west, south, east, north, rings: [exterior, ...polygon.slice(1).map(ring => unwrap(ring, center))] });
  }
  return (coordinates, { accuracyMeters = 0 } = {}) => {
    if (!validPosition(coordinates) || !Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > 100_000) return null;
    const [longitude, latitude] = coordinates;
    const guard = COUNTRY_BOUNDARY_GUARD_METERS + accuracyMeters;
    const dy = guard / METERS_PER_DEGREE, dx = dy / Math.cos(latitude * Math.PI / 180);
    let match: string | null = null;
    for (const polygon of prepared) {
      const x = longitude + 360 * Math.round(((polygon.west + polygon.east) / 2 - longitude) / 360);
      if (latitude < polygon.south - dy || latitude > polygon.north + dy || x < polygon.west - dx || x > polygon.east + dx) continue;
      const outer = ringRelation(polygon.rings[0], x, latitude, guard);
      if (outer === 'boundary') return null;
      if (outer === 'outside') continue;
      let inHole = false;
      for (const hole of polygon.rings.slice(1)) {
        const relation = ringRelation(hole, x, latitude, guard);
        if (relation === 'boundary') return null;
        if (relation === 'inside') { inHole = true; break; }
      }
      if (inHole) continue;
      if (!polygon.code || match && match !== polygon.code) return null;
      match = polygon.code;
    }
    return match;
  };
}

let lookupPromise: Promise<CountryLookup> | undefined;

/** Lazy bundled data; no geocoder, network coordinates, location persistence or nearest-country guess. */
export async function countryForCoordinates(coordinates: CountryCoordinates, options: CountryLookupOptions = {}): Promise<string | null> {
  if (!validPosition(coordinates)) return null;
  try {
    lookupPromise ??= import('./location-country-data.json', { with: { type: 'json' } })
      .then(module => createCountryLookup(module.default as unknown as CountryBoundaryData))
      .catch(error => { lookupPromise = undefined; throw error; });
    return (await lookupPromise)(coordinates, options);
  } catch { return null; }
}
