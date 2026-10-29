import {currentPosition,nearbyPoint,type NearbyPoint} from './location-filter.ts'
export const USER_LOCATION_KEY='market.user-location.v1'
type ManualArea={point:NearbyPoint;label:string}
type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>
export function coarseArea(point:readonly number[],label=''):ManualArea {
  if(point.length!==2||!point.every(Number.isFinite)||Math.abs(point[0])>180||Math.abs(point[1])>90)throw new Error('Choose an area on the map.')
  return {point:[Math.round(point[0]*100)/100,Math.round(point[1]*100)/100],label:label.trim().slice(0,80)}
}
/** Manual fallback is persisted; device fixes exist only in this controller's memory. */
export function createUserLocationStore({storage,onChange=()=>{},permissions,geolocation,isPreview=false}:{storage?:StorageLike;onChange?:()=>void;permissions?:Pick<Permissions,'query'>;geolocation?:Pick<Geolocation,'getCurrentPosition'>;isPreview?:boolean}={}) {
  let manual:ManualArea|null=null,device:NearbyPoint|null=null,ticket=0,disposed=false
  if(!isPreview)try{const raw=JSON.parse(storage?.getItem(USER_LOCATION_KEY)||'null');if(raw)manual=coarseArea(raw.point,typeof raw.label==='string'?raw.label:'')}catch{/* Invalid or unavailable storage is an empty preference. */}
  const emit=()=>{if(!disposed)onChange()}
  async function locate(explicit=false):Promise<boolean> {
    if(disposed||isPreview)return false
    const version=++ticket
    try {
      if(!explicit){if(!permissions)return false;const permission=await permissions.query({name:'geolocation'});if(disposed||version!==ticket||permission.state!=='granted')return false}
      const fix=await currentPosition(geolocation)
      if(disposed||version!==ticket)return false
      device=nearbyPoint(fix.coords);emit();return true
    }catch{return false}
  }
  return {
    point:():NearbyPoint|null=>device||manual?.point||null,
    label:()=>device?'Device location':manual?.label|| (manual?'Selected area':'Choose area'),
    manual:()=>manual,
    locate,
    cancelPending(){ticket++},
    choose(point:readonly number[],label='') {if(disposed)return;const area=coarseArea(point,label);ticket++;device=null;manual=area;if(!isPreview)try{storage?.setItem(USER_LOCATION_KEY,JSON.stringify(area))}catch{}emit()},
    clear(){if(disposed)return;ticket++;device=null;manual=null;if(!isPreview)try{storage?.removeItem(USER_LOCATION_KEY)}catch{}emit()},
    dispose(){disposed=true;ticket++;device=null},
  }
}
