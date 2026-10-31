import {createDeliveryPlaceInput} from './delivery-place-ui.ts';
import type {DeliveryPlace} from './orders.ts';

/** Private draft projection only: never stored, published or placed in the URL. */
export function cleanNativePlace(value: unknown): DeliveryPlace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid place');
  const place = value as Record<string, unknown>;
  if (Object.keys(place).some(key => !['label','address','coordinates'].includes(key)) || typeof place.label !== 'string' || place.label.length > 120 || typeof place.address !== 'string' || place.address.length > 500) throw new Error('Invalid place');
  const point=place.coordinates;
  if (point !== undefined && (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90)) throw new Error('Invalid point');
  return {label:place.label,address:place.address,...(point?{coordinates:[...point as [number,number]] as [number,number]}:{})};
}
export function mountNativePlace({createPicker=createDeliveryPlaceInput}:{createPicker?:typeof createDeliveryPlaceInput}={}) {
  let closed=false,serial=0,projection='';
  const pending=new Map<string,{success:PositionCallback;failure?:PositionErrorCallback;timer:ReturnType<typeof setTimeout>}>();
  const post=(value:Record<string,unknown>)=>{
    const host=window as any;
    if(host.webkit?.messageHandlers?.marketMap)host.webkit.messageHandlers.marketMap.postMessage(value);
    else if(value.type==='ready')host.MarketMapBridge?.placeReady();
    else if(value.type==='place')host.MarketMapBridge?.placeChanged(JSON.stringify(value.place));
    else if(value.type==='locate')host.MarketMapBridge?.requestLocation(value.id);
  };
  const fail=(id:string)=>{const entry=pending.get(id);if(!entry)return;pending.delete(id);clearTimeout(entry.timer);entry.failure?.({code:2,message:'Location unavailable'} as GeolocationPositionError);};
  const picker=createPicker({label:'Meeting point',onDraftChange:place=>{projection=JSON.stringify(place);post({type:'place',place});},geolocation:{getCurrentPosition(success,failure){if(closed)return;const id=String(++serial),timer=setTimeout(()=>fail(id),12000);pending.set(id,{success,failure,timer});post({type:'locate',id});}}});
  document.getElementById('map-canvas')?.replaceWith(picker.element);
  for(const node of document.querySelectorAll<HTMLElement>('.map-storage,#map-status'))node.hidden=true;
  document.title='Meeting point';
  const api={
    setValue(value:unknown){if(closed)return;try{const place=cleanNativePlace(value),key=JSON.stringify(place);if(key!==projection){projection=key;picker.setValue(place);}}catch{/* Keep valid entered draft. */}},
    setDark(dark:boolean){document.documentElement.dataset.appearance=dark?'dark':'light';window.dispatchEvent(new Event('market-themechange'));},
    setLocation(id:string,point:unknown){if(closed)return;const entry=pending.get(id);if(!entry)return;try{const place=cleanNativePlace({label:'',address:'',coordinates:point});if(!place.coordinates){fail(id);return;}pending.delete(id);clearTimeout(entry.timer);entry.success({coords:{longitude:place.coordinates[0],latitude:place.coordinates[1]},timestamp:Date.now()} as GeolocationPosition);}catch{fail(id);}},
  };
  (window as any).marketPlace=api;
  window.addEventListener('pagehide',()=>{closed=true;for(const id of pending.keys())fail(id);picker.destroy();},{once:true});
  post({type:'ready',mode:'place',version:1});return api;
}
