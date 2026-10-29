import type { MapViewport } from './map/index.ts'
import {serviceAreaContains,type ServiceAreas} from './service-area.ts'
export type NearbyPoint = readonly [longitude: number, latitude: number]
export const NEARBY_KM = 50
export const NEARBY_LABEL = `Within ${NEARBY_KM} km`

/** Keep only a coarse position in memory; never persist a precise browser fix. */
export function nearbyPoint(coords: Pick<GeolocationCoordinates, 'longitude' | 'latitude' | 'accuracy'>): NearbyPoint {
  const {longitude,latitude,accuracy}=coords
  if(!Number.isFinite(longitude)||Math.abs(longitude)>180||!Number.isFinite(latitude)||Math.abs(latitude)>90||!Number.isFinite(accuracy)||accuracy<0||accuracy>10000)throw new Error('Location is too approximate. Enter a city or area instead.')
  return [Math.round(longitude*100)/100,Math.round(latitude*100)/100]
}
export function isNearby(coordinates: readonly number[] | null | undefined, centre: NearbyPoint): boolean {
  if(!coordinates||coordinates.length!==2||!coordinates.every(Number.isFinite))return false
  const rad=Math.PI/180,[lng,lat]=coordinates,[originLng,originLat]=centre
  const a=Math.sin((lat-originLat)*rad/2)**2+Math.cos(lat*rad)*Math.cos(originLat*rad)*Math.sin((lng-originLng)*rad/2)**2
  return 6371*2*Math.atan2(Math.sqrt(Math.min(1,a)),Math.sqrt(Math.max(0,1-a)))<=NEARBY_KM
}
/** Services must actually cover the chosen pickup point; discovery cells are only hints. */
export function listingMatchesNearby(listing:{coordinates?:readonly number[]|null;serviceAreas?:ServiceAreas|null},centre:NearbyPoint):boolean {
  return listing.serviceAreas?serviceAreaContains(listing.serviceAreas.pickup,centre):isNearby(listing.coordinates,centre)
}
export function nearbyViewport([longitude,latitude]:NearbyPoint):MapViewport {
  const latitudeDelta=NEARBY_KM/111.195,longitudeDelta=Math.min(180,latitudeDelta/Math.max(.00001,Math.cos(latitude*Math.PI/180)))
  return {west:longitude-longitudeDelta,east:longitude+longitudeDelta,south:Math.max(-90,latitude-latitudeDelta),north:Math.min(90,latitude+latitudeDelta),zoom:9}
}
export function currentPosition(geolocation: Pick<Geolocation,'getCurrentPosition'> | undefined = globalThis.navigator?.geolocation):Promise<GeolocationPosition> {
  if(!geolocation)return Promise.reject(new Error('Location is unavailable. Choose a country or enter an area.'))
  return new Promise((resolve,reject)=>geolocation.getCurrentPosition(resolve,error=>reject(new Error(error.code===1?'Location access is off. Choose a country or enter an area.':error.code===3?'Location took too long. Try again.':'Could not find your location. Try again.')),{enableHighAccuracy:false,timeout:10000,maximumAge:300000}))
}
