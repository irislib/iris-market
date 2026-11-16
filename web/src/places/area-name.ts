import labels from './labels.json' with {type:'json'};

type Label = {name: string; lat: number; lng: number; population?: number};
const NEAR_KM = 30;

function km(a: {lat: number; lng: number}, lat: number, lng: number) {
  const rad = Math.PI / 180, x = (lng - a.lng) * rad * Math.cos((lat + a.lat) * rad / 2), y = (lat - a.lat) * rad;
  return Math.hypot(x, y) * 6371;
}

/**
 * A name for a public area from the bundled place list, without any network lookup:
 * the largest town inside it, else the nearest one close by.
 */
export function areaName([west, south, east, north]: readonly [number, number, number, number]): string | null {
  const places = (labels as {labels: (Label & {kind?: string})[]}).labels.filter(place => place.kind === 'city');
  const inside = places.filter(place => place.lng >= west && place.lng <= east && place.lat >= south && place.lat <= north);
  if (inside.length) return inside.reduce((best, place) => (place.population ?? 0) > (best.population ?? 0) ? place : best).name;
  const lat = (south + north) / 2, lng = (west + east) / 2;
  let best: Label | null = null, distance = NEAR_KM;
  for (const place of places) { const d = km(place, lat, lng); if (d < distance) { best = place; distance = d; } }
  return best?.name ?? null;
}
