/** Iris Market service-area extension v1, carried inside a signed kind-30402 listing.
 * ['service_area','1','pickup'|'destination', JSON.stringify(GeoJSON geometry)]
 * ['g', geohash, 'pickup'|'destination'] indexes the UNION of the two areas.
 * These third-field roles are a custom extension, not point locations: pin parsers
 * must ignore them. Index cells may overmatch; the geometry is authoritative.
 */
export type ServiceAreaPoint = [number, number]
export type ServiceAreaRing = ServiceAreaPoint[]
export type ServiceAreaPolygon = { type: 'Polygon'; coordinates: ServiceAreaRing[] }
export type ServiceAreaGeometry = ServiceAreaPolygon | { type: 'MultiPolygon'; coordinates: ServiceAreaRing[][] }
export interface ServiceAreas { pickup: ServiceAreaGeometry; destination: ServiceAreaGeometry }
export type ServiceAreaBounds = [west: number, south: number, east: number, north: number]
export const SERVICE_AREA_VERSION = '1'
export const MAX_SERVICE_AREA_VERTICES = 256
export const MAX_SERVICE_AREA_BYTES = 16 * 1024
export const MAX_SERVICE_AREA_G_TAGS = 512
export const MAX_SERVICE_AREA_COVER_LEAVES = 64
export const MIN_SERVICE_AREA_RADIUS_KM = 0.1
export const MAX_SERVICE_AREA_RADIUS_KM = 2000
const MAX_POLYGONS = 16, MAX_RINGS = 32, MAX_PRECISION = 8
const ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz'
const EPSILON = 1e-10
const encoder = new TextEncoder()
const checked = new WeakSet<object>()
function error(message: string): never { throw new Error(message) }
const polygons = (area: ServiceAreaGeometry): ServiceAreaRing[][] => area.type === 'Polygon' ? [area.coordinates] : area.coordinates
const validPoint = (p: unknown): p is ServiceAreaPoint => Array.isArray(p) && p.length === 2 &&
  p.every(v => typeof v === 'number' && Number.isFinite(v)) && p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90
const same = (a: ServiceAreaPoint, b: ServiceAreaPoint) => a[0] === b[0] && a[1] === b[1]
const cross = (a: ServiceAreaPoint, b: ServiceAreaPoint, p: ServiceAreaPoint) => (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0])
function onSegment(p: ServiceAreaPoint, a: ServiceAreaPoint, b: ServiceAreaPoint): boolean {
  return Math.abs(cross(a,b,p)) <= EPSILON * Math.hypot(b[0]-a[0],b[1]-a[1]) &&
    p[0] >= Math.min(a[0],b[0])-EPSILON && p[0] <= Math.max(a[0],b[0])+EPSILON &&
    p[1] >= Math.min(a[1],b[1])-EPSILON && p[1] <= Math.max(a[1],b[1])+EPSILON
}
function intersects(a: ServiceAreaPoint,b: ServiceAreaPoint,c: ServiceAreaPoint,d: ServiceAreaPoint): boolean {
  if(onSegment(a,c,d)||onSegment(b,c,d)||onSegment(c,a,b)||onSegment(d,a,b))return true
  return (cross(a,b,c)>0)!==(cross(a,b,d)>0) && (cross(c,d,a)>0)!==(cross(c,d,b)>0)
}
/** -1 outside, 0 boundary, 1 inside. Ring direction is immaterial. */
function inRing(point: ServiceAreaPoint, ring: ServiceAreaRing): -1|0|1 {
  let inside = false
  for(let i=0;i<ring.length-1;i++){
    const a=ring[i],b=ring[i+1]
    if(onSegment(point,a,b))return 0
    if((a[1]>point[1])!==(b[1]>point[1]) && point[0] < (b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside
  }
  return inside ? 1 : -1
}
function inPolygon(point: ServiceAreaPoint, rings: ServiceAreaRing[]): boolean {
  return inRing(point,rings[0]) >= 0 && rings.slice(1).every(hole=>inRing(point,hole) === -1)
}
function ringsIntersect(a: ServiceAreaRing,b: ServiceAreaRing): boolean {
  for(let i=0;i<a.length-1;i++)for(let j=0;j<b.length-1;j++)if(intersects(a[i],a[i+1],b[j],b[j+1]))return true
  return false
}
function ringBounds(ring: ServiceAreaRing): ServiceAreaBounds {
  return [Math.min(...ring.map(p=>p[0])),Math.min(...ring.map(p=>p[1])),Math.max(...ring.map(p=>p[0])),Math.max(...ring.map(p=>p[1]))]
}
function boundsOf(area: ServiceAreaGeometry): ServiceAreaBounds {
  const bounds=polygons(area).map(p=>ringBounds(p[0]))
  return [Math.min(...bounds.map(b=>b[0])),Math.min(...bounds.map(b=>b[1])),Math.max(...bounds.map(b=>b[2])),Math.max(...bounds.map(b=>b[3]))]
}

/** Clones and freezes bounded valid geometry. Date-line crossings are explicit v1 exclusions. */
export function validateServiceArea(input: unknown): ServiceAreaGeometry {
  if(input && typeof input==='object' && checked.has(input))return input as ServiceAreaGeometry
  if(!input || typeof input!=='object' || Array.isArray(input))error('Choose a valid service area')
  const value=input as Record<string,unknown>
  if(Object.keys(value).some(k=>k!=='type'&&k!=='coordinates') || !['Polygon','MultiPolygon'].includes(value.type as string))error('Service areas need a Polygon or MultiPolygon')
  if(!Array.isArray(value.coordinates))error('Invalid service-area coordinates')
  const source:unknown[]=value.type==='Polygon' ? [value.coordinates] : value.coordinates
  if(!source.length || source.length>MAX_POLYGONS)error('Too many service-area polygons')
  let vertices=0,ringCount=0
  const result:ServiceAreaRing[][]=[]
  for(const rawPolygon of source){
    if(!Array.isArray(rawPolygon) || !rawPolygon.length || (ringCount+=rawPolygon.length)>MAX_RINGS)error('Too many service-area rings')
    const rings:ServiceAreaRing[]=[]
    for(const raw of rawPolygon){
      if(!Array.isArray(raw) || raw.length<4 || (vertices+=raw.length)>MAX_SERVICE_AREA_VERTICES)error('Service-area outlines are too detailed')
      if(!raw.every(validPoint))error('Service-area coordinates must be finite WGS84 longitude and latitude')
      const ring:ServiceAreaRing=raw.map(p=>[p[0],p[1]])
      if(!same(ring[0],ring.at(-1)!))error('Close every service-area ring')
      for(let i=0;i<ring.length-1;i++){
        if(same(ring[i],ring[i+1]))error('Service-area rings contain duplicate points')
        if(Math.abs(ring[i][0]-ring[i+1][0])>180)error('Service areas crossing the date line are not supported yet')
        for(let j=i+1;j<ring.length-1;j++){
          if(j===i+1 || (i===0&&j===ring.length-2))continue
          if(intersects(ring[i],ring[i+1],ring[j],ring[j+1]))error('Service-area rings must not cross themselves')
        }
      }
      let area=0
      for(let i=0;i<ring.length-1;i++)area+=ring[i][0]*ring[i+1][1]-ring[i+1][0]*ring[i][1]
      if(Math.abs(area)<1e-12)error('Service areas need a nonzero area')
      if(rings.length){
        if(inRing(ring[0],rings[0])!==1 || ringsIntersect(ring,rings[0]))error('Service-area holes must stay inside the outline')
        for(const hole of rings.slice(1))if(ringsIntersect(ring,hole)||inRing(ring[0],hole)>=0||inRing(hole[0],ring)>=0)error('Service-area holes must not overlap')
      }
      rings.push(ring)
    }
    for(const previous of result){
      if(rings.some(a=>previous.some(b=>ringsIntersect(a,b)))||inPolygon(rings[0][0],previous)||inPolygon(previous[0][0],rings))error('Service-area polygons must not overlap or touch')
    }
    result.push(rings)
  }
  const area:ServiceAreaGeometry=value.type==='Polygon' ? {type:'Polygon',coordinates:result[0]} : {type:'MultiPolygon',coordinates:result}
  const bounds=boundsOf(area)
  if(bounds[2]-bounds[0]>180)error('Service areas crossing the date line are not supported yet')
  if(encoder.encode(JSON.stringify(area)).length>MAX_SERVICE_AREA_BYTES)error('Service area is too large')
  for(const p of result){for(const ring of p){for(const point of ring)Object.freeze(point);Object.freeze(ring)}Object.freeze(p)}
  if(area.type==='MultiPolygon')Object.freeze(area.coordinates)
  Object.freeze(area);checked.add(area);return area
}

export function parseServiceAreas(tags: readonly (readonly string[])[]): ServiceAreas|null {
  if(!Array.isArray(tags)||tags.length>2048)return null
  const rows=tags.filter(tag=>Array.isArray(tag)&&tag[0]==='service_area')
  if(rows.length!==2)return null
  const areas:Partial<ServiceAreas>={}
  try{
    for(const row of rows){
      if(row.length!==4||row[1]!==SERVICE_AREA_VERSION||!['pickup','destination'].includes(row[2])||typeof row[3]!=='string'||encoder.encode(row[3]).length>MAX_SERVICE_AREA_BYTES)return null
      const role=row[2] as keyof ServiceAreas
      if(areas[role])return null
      areas[role]=validateServiceArea(JSON.parse(row[3]))
    }
    return areas.pickup&&areas.destination ? {pickup:areas.pickup,destination:areas.destination} : null
  }catch{return null}
}

/** Outer boundaries count; holes, including their boundaries, do not. Invalid geometry fails closed. */
export function serviceAreaContains(area: unknown, point: unknown): boolean {
  if(!validPoint(point))return false
  try{return polygons(validateServiceArea(area)).some(rings=>inPolygon(point,rings))}catch{return false}
}
export function serviceAreaBounds(area: ServiceAreaGeometry): ServiceAreaBounds { return boundsOf(validateServiceArea(area)) }
/** Camera centre only, not a claim that this point is inside a concave area or outside its holes. */
export function serviceAreaCenter(area: ServiceAreaGeometry): ServiceAreaPoint {
  const [west,south,east,north]=serviceAreaBounds(area);return [(west+east)/2,(south+north)/2]
}

/** A 64-edge geodesic circle in kilometres; never a longitude-degree radius approximation. */
export function serviceAreaCircle(center: ServiceAreaPoint,radiusKm: number): ServiceAreaPolygon {
  if(!validPoint(center)||!Number.isFinite(radiusKm)||radiusKm<MIN_SERVICE_AREA_RADIUS_KM||radiusKm>MAX_SERVICE_AREA_RADIUS_KM)error('Choose a radius from 0.1 to 2000 km')
  const radians=Math.PI/180,lat=center[1]*radians,lon=center[0]*radians,distance=radiusKm/6371.0088
  const ring:ServiceAreaRing=[]
  for(let i=0;i<64;i++){
    const bearing=i*Math.PI/32
    const phi=Math.asin(Math.sin(lat)*Math.cos(distance)+Math.cos(lat)*Math.sin(distance)*Math.cos(bearing))
    const lambda=lon+Math.atan2(Math.sin(bearing)*Math.sin(distance)*Math.cos(lat),Math.cos(distance)-Math.sin(lat)*Math.sin(phi))
    ring.push([Number((((lambda/radians+180)%360+360)%360-180).toFixed(6)),Number((phi/radians).toFixed(6))])
  }
  ring.push([...ring[0]])
  return validateServiceArea({type:'Polygon',coordinates:[ring]}) as ServiceAreaPolygon
}

// Grid encoding matches map/geohash.ts; integer cells avoid sampling gaps.
function gridHash(x:number,y:number,precision:number):string {
  let longitudeBit=Math.ceil(precision*5/2)-1,latitudeBit=Math.floor(precision*5/2)-1,character=0,value=''
  for(let bit=0;bit<precision*5;bit++){
    character=character*2+(bit%2===0?(x>>longitudeBit--)&1:(y>>latitudeBit--)&1)
    if(bit%5===4){value+=ALPHABET[character];character=0}
  }
  return value
}
function coverAt(area:ServiceAreaGeometry,precision:number):string[]|null {
  const columns=2**Math.ceil(precision*5/2),rows=2**Math.floor(precision*5/2),cells=new Set<string>()
  const column=(lon:number)=>Math.min(columns-1,Math.max(0,Math.floor((lon+180)/360*columns)))
  const row=(lat:number)=>Math.min(rows-1,Math.max(0,Math.floor((lat+90)/180*rows)))
  for(const polygon of polygons(area)){
    const [west,south,east,north]=ringBounds(polygon[0]),x0=column(west),x1=column(east),y0=row(south),y1=row(north)
    if((x1-x0+1)*(y1-y0+1)>MAX_SERVICE_AREA_COVER_LEAVES)return null
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){
      cells.add(gridHash(x,y,precision));if(cells.size>MAX_SERVICE_AREA_COVER_LEAVES)return null
    }
  }
  return [...cells].sort()
}
function indexedCells(area:ServiceAreaGeometry):string[] {
  for(let precision=MAX_PRECISION;precision>=1;precision--){
    const leaves=coverAt(area,precision);if(!leaves)continue
    const values=new Set<string>()
    for(const leaf of leaves)for(let length=1;length<=leaf.length;length++)values.add(leaf.slice(0,length))
    if(values.size<=MAX_SERVICE_AREA_G_TAGS/2)return [...values].sort()
  }
  return error('Service area cannot be indexed')
}
/** Both area roles are written explicitly; omitted destination means the same geometry. */
export function serviceAreaTags({pickup,destination=pickup}:{pickup:ServiceAreaGeometry;destination?:ServiceAreaGeometry}):string[][] {
  const areas:ServiceAreas={pickup:validateServiceArea(pickup),destination:validateServiceArea(destination)}
  const tags:string[][]=[]
  for(const role of ['pickup','destination'] as const){
    tags.push(['service_area',SERVICE_AREA_VERSION,role,JSON.stringify(areas[role])])
    for(const hash of indexedCells(areas[role]))tags.push(['g',hash,role])
  }
  return tags
}
