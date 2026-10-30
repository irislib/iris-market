import type {OrderView, ShipmentStop} from './orders.ts';

/** Only an assigned, active stop can be acted on in the provider workspace. */
export function nextTransportStop(order:OrderView,owner?:string):ShipmentStop|undefined {
  if(!owner||order.archived||!['accepted','in-transit'].includes(order.status))return;
  return order.shipment.stops.find(stop=>stop.status!=='completed'&&(order.seller===owner||stop.courierPubkey===owner));
}

export function transportProgress(order:Pick<OrderView,'shipment'>):{completed:number;total:number} {
  const stops=order.shipment.stops;
  return {completed:stops.filter(stop=>stop.status==='completed').length,total:stops.length};
}

/** The user opens directions explicitly. Never include identities or order IDs. */
export function stopDirections(stop:Pick<ShipmentStop,'coordinates'|'address'>):string|null {
  const point=stop.coordinates;
  const destination=point&&point.length===2&&point.every(Number.isFinite)&&Math.abs(point[0])<=180&&Math.abs(point[1])<=90
    ? `${point[1]},${point[0]}` : stop.address?.trim();
  if(!destination)return null;
  const url=new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api','1');url.searchParams.set('destination',destination);
  return url.href;
}
