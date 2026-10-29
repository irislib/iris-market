export type CourierType='parcel'|'passenger'|'both';
const clean=(value:string)=>value.normalize('NFKC').trim().toLowerCase();
const known=new Set(['courier','parcel','parcels','delivery','deliveries','passenger','passengers','ride','rides']);
export const isTransportTag=(value:string)=>known.has(clean(value));
/** Explicit service tags only: buying a car is not a driving gig. */
export function courierListingType(listing:{tags?:readonly string[]}):CourierType|null {
  const tags=new Set((listing.tags??[]).slice(0,64).map(clean));
  const passenger=['passenger','passengers','ride','rides'].some(tag=>tags.has(tag));
  const parcel=['parcel','parcels','delivery','deliveries'].some(tag=>tags.has(tag))||!passenger&&tags.has('courier');
  return passenger&&parcel?'both':passenger?'passenger':parcel?'parcel':null;
}
export function transportTypeTags(type:unknown):string[] {
  if(type===undefined||type===null||type===''||type==='none')return [];
  if(!['parcel','passenger','both'].includes(String(type)))throw Error('Choose a transport type.');
  return ['courier',...(type!=='passenger'?['parcel']:[]),...(type!=='parcel'?['passenger']:[])];
}
