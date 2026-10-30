/** Synthetic public-place routes; these never represent a person or a real journey. */
export type Coordinates = [number, number];
export type DemoStage = 'to_pickup' | 'pickup' | 'to_dropoff' | 'complete';
export interface DemoScenario {
  kind: 'delivery' | 'ride';
  actor: 'drone' | 'driver';
  start: Coordinates;
  pickup: {id: string; name: string; coordinates: Coordinates};
  dropoff: {id: string; name: string; coordinates: Coordinates};
}
export const DEMO_SCENARIOS: Record<'delivery' | 'ride', DemoScenario> = {
  delivery: {kind:'delivery',actor:'drone',start:[24.941,60.167],pickup:{id:'demo-parcel-pickup',name:'Market Square demo pickup',coordinates:[24.952,60.167]},dropoff:{id:'demo-parcel-dropoff',name:'Kaisaniemi demo dropoff',coordinates:[24.947,60.176]}},
  ride: {kind:'ride',actor:'driver',start:[24.928,60.169],pickup:{id:'demo-passenger-pickup',name:'Central Station demo pickup',coordinates:[24.941,60.171]},dropoff:{id:'demo-passenger-dropoff',name:'Hakaniemi demo dropoff',coordinates:[24.95,60.18]}},
};
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const interpolate = (from: Coordinates, to: Coordinates, fraction: number): Coordinates => [from[0]+(to[0]-from[0])*clamp(fraction),from[1]+(to[1]-from[1])*clamp(fraction)];
export function simulationAt(scenario: DemoScenario, elapsedMs: number, durationMs = 120000) {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Invalid demo timeline');
  for (const point of [scenario.start,scenario.pickup.coordinates,scenario.dropoff.coordinates]) {
    if (point.length !== 2 || !point.every(Number.isFinite) || Math.abs(point[0])>180 || Math.abs(point[1])>90) throw new Error('Invalid demo coordinates');
  }
  const progress = clamp(elapsedMs/durationMs);
  const stage: DemoStage = progress < .25 ? 'to_pickup' : progress < .35 ? 'pickup' : progress < 1 ? 'to_dropoff' : 'complete';
  const position = stage==='to_pickup' ? interpolate(scenario.start,scenario.pickup.coordinates,progress/.25) : stage==='pickup' ? [...scenario.pickup.coordinates] as Coordinates : interpolate(scenario.pickup.coordinates,scenario.dropoff.coordinates,(progress-.35)/.65);
  const pickupStatus:'pending'|'arrived'|'completed' = progress < .25 ? 'pending' : progress < .35 ? 'arrived' : 'completed';
  return {progress,stage,position,activeStopId:progress < .35 ? scenario.pickup.id : scenario.dropoff.id,
    stops:[{...scenario.pickup,coordinates:[...scenario.pickup.coordinates] as Coordinates,kind:'pickup' as const,status:pickupStatus},{...scenario.dropoff,coordinates:[...scenario.dropoff.coordinates] as Coordinates,kind:'dropoff' as const,status:progress===1?'completed' as const:'pending' as const}],
    label: stage==='to_pickup'?'Simulated approach to pickup':stage==='pickup'?(scenario.kind==='ride'?'Simulated passenger boarding':'Simulated parcel pickup'):stage==='to_dropoff'?'Simulated travel to dropoff':'Simulation complete'};
}
