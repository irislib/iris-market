import test from 'node:test'
import assert from 'node:assert/strict'
import {parseServiceAreas,serviceAreaTags,serviceAreaContains,serviceAreaBounds,serviceAreaCenter,serviceAreaCircle,
  validateServiceArea,MAX_SERVICE_AREA_VERTICES,MAX_SERVICE_AREA_BYTES,MAX_SERVICE_AREA_G_TAGS,MAX_SERVICE_AREA_COVER_LEAVES} from '../src/service-area.ts'
import {decodeGeohash} from '../src/map/geohash.ts'

const ring=(w,s,e,n)=>[[w,s],[e,s],[e,n],[w,n],[w,s]]
const box=(w,s,e,n)=>({type:'Polygon',coordinates:[ring(w,s,e,n)]})
const distance=(a,b)=>{
  const r=Math.PI/180,dlat=(b[1]-a[1])*r,dlon=(b[0]-a[0])*r
  return 6371.0088*2*Math.asin(Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(dlon/2)**2))
}
const leafCells=(tags,role)=>{
  const hashes=tags.filter(t=>t[0]==='g'&&t[2]===role).map(t=>t[1]),precision=Math.max(...hashes.map(h=>h.length))
  return hashes.filter(h=>h.length===precision).map(decodeGeohash)
}
const covered=(cells,[lon,lat])=>cells.some(({bounds:[w,s,e,n]})=>lon>=w&&lon<=e&&lat>=s&&lat<=n)

test('signed listing extension round trips separate pickup and destination with role-marked indexes',()=>{
  const pickup=box(24,60,25,61),destination=box(23,61,24,62),tags=serviceAreaTags({pickup,destination})
  assert.deepEqual(tags.filter(t=>t[0]==='service_area'),[
    ['service_area','1','pickup',JSON.stringify(pickup)],['service_area','1','destination',JSON.stringify(destination)]])
  assert.deepEqual(parseServiceAreas(tags),{pickup,destination})
  assert(tags.filter(t=>t[0]==='g').every(t=>t.length===3&&['pickup','destination'].includes(t[2])))
  assert.deepEqual(parseServiceAreas(serviceAreaTags({pickup})),{pickup,destination:pickup})
})

test('outer edge is included and hole edge and interior are excluded regardless of winding',()=>{
  const area={type:'Polygon',coordinates:[ring(0,0,10,10),ring(3,3,7,7)]}
  for(const p of [[0,0],[10,5],[1,1],[5,10]])assert.equal(serviceAreaContains(area,p),true,`${p}`)
  for(const p of [[5,5],[3,5],[7,7],[-.1,0],[10.1,5]])assert.equal(serviceAreaContains(area,p),false,`${p}`)
  assert.equal(serviceAreaContains({type:'Polygon',coordinates:area.coordinates.map(r=>[...r].reverse())},[1,1]),true)
})

test('MultiPolygon keeps disjoint areas and an island inside a hole without filling the gap',()=>{
  const area={type:'MultiPolygon',coordinates:[[ring(0,0,10,10),ring(2,2,8,8)],[ring(4,4,6,6)],[ring(15,0,20,5)]]}
  for(const p of [[1,1],[5,5],[16,1]])assert(serviceAreaContains(area,p))
  for(const p of [[3,3],[12,2],[30,1]])assert.equal(serviceAreaContains(area,p),false)
  assert.deepEqual(serviceAreaBounds(area),[0,0,20,10])
})

test('invalid WGS84, unclosed, self-crossing, zero-area and malformed geometries fail closed',()=>{
  const bad=[
    box(-181,0,1,1),box(0,0,1,91),{type:'Polygon',coordinates:[[[0,0],[NaN,1],[1,0],[0,0]]]},
    {type:'Polygon',coordinates:[[[0,0],[Infinity,1],[1,0],[0,0]]]},
    {type:'Polygon',coordinates:[[[0,0,1],[1,0],[1,1],[0,0,1]]]},
    {type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1]]]},
    {type:'Polygon',coordinates:[[[0,0],[2,2],[0,2],[2,0],[0,0]]]},
    {type:'Polygon',coordinates:[[[0,0],[1,0],[2,0],[0,0]]]},
    {type:'Polygon',coordinates:[]},{type:'MultiPolygon',coordinates:[]},{type:'Point',coordinates:[0,0]},
  ]
  for(const area of bad){assert.throws(()=>validateServiceArea(area));assert.equal(serviceAreaContains(area,[.1,.1]),false)}
  for(const p of [[0,NaN],[181,0],[0,91],[0,0,1],['0',0]])assert.equal(serviceAreaContains(box(0,0,1,1),p),false)
})

test('invalid holes and overlapping polygon components are rejected',()=>{
  for(const area of [
    {type:'Polygon',coordinates:[ring(0,0,10,10),ring(9,9,11,11)]},
    {type:'Polygon',coordinates:[ring(0,0,10,10),ring(0,1,2,2)]},
    {type:'Polygon',coordinates:[ring(0,0,10,10),ring(2,2,6,6),ring(4,4,8,8)]},
    {type:'MultiPolygon',coordinates:[[ring(0,0,10,10)],[ring(2,2,4,4)]]},
  ])assert.throws(()=>validateServiceArea(area))
})

test('size, vertex, role and version bounds reject oversized or ambiguous signed tags',()=>{
  const area=box(24,60,25,61),tags=serviceAreaTags({pickup:area}),rows=tags.filter(t=>t[0]==='service_area')
  const points=Array.from({length:MAX_SERVICE_AREA_VERTICES},(_,i)=>[Math.cos(i*2*Math.PI/MAX_SERVICE_AREA_VERTICES),Math.sin(i*2*Math.PI/MAX_SERVICE_AREA_VERTICES)])
  assert.throws(()=>validateServiceArea({type:'Polygon',coordinates:[[...points,points[0]]]}),/detailed/)
  for(const invalid of [[],[rows[0]],[rows[0],rows[0]],[[...rows[0]],['service_area','2','destination',rows[1][3]]],
    [[...rows[0]],['service_area','1','destination',' '.repeat(MAX_SERVICE_AREA_BYTES)+rows[1][3]]],
    [...rows,['service_area','1','pickup',rows[0][3]]],[[...rows[0]],['service_area','1','destination','{}']]])assert.equal(parseServiceAreas(invalid),null)
})

test('date-line crossings are explicitly rejected instead of covering the wrong hemisphere',()=>{
  assert.throws(()=>validateServiceArea(box(170,-10,-170,10)),/date line/)
  assert.throws(()=>serviceAreaCircle([179.9,20],100),/date line/)
  assert.throws(()=>validateServiceArea({type:'MultiPolygon',coordinates:[[ring(170,0,175,5)],[ring(-175,0,-170,5)]]}),/date line/)
})

test('Finland circles use kilometre radii at northern latitudes',()=>{
  for(const [center,radius] of [[[24.9384,60.1699],10],[[27,69],500],[[24.9384,60.1699],.1]]){
    const area=serviceAreaCircle(center,radius)
    assert.equal(area.coordinates[0].length,65)
    assert.deepEqual(area.coordinates[0][0],area.coordinates[0].at(-1))
    assert(serviceAreaContains(area,center))
    for(const p of area.coordinates[0])assert(Math.abs(distance(center,p)-radius)<.001,`${center},${radius}: ${p}`)
    assert.equal(serviceAreaContains(area,[center[0],center[1]-radius/80]),false)
  }
  for(const radius of [0,-1,2001,NaN,Infinity,'10'])assert.throws(()=>serviceAreaCircle([25,60],radius))
})

test('index covers are complete, bounded, and include every prefix for both roles',()=>{
  for(const pickup of [box(-20,-20,20,20),serviceAreaCircle([25,60],.1),serviceAreaCircle([25,60],1000)]){
    const tags=serviceAreaTags({pickup}),geo=tags.filter(t=>t[0]==='g')
    assert(geo.length<=MAX_SERVICE_AREA_G_TAGS)
    for(const role of ['pickup','destination']){
      const leaves=leafCells(tags,role),hashes=new Set(geo.filter(t=>t[2]===role).map(t=>t[1]))
      assert(leaves.length<=MAX_SERVICE_AREA_COVER_LEAVES)
      for(const {geohash} of leaves)for(let p=1;p<=geohash.length;p++)assert(hashes.has(geohash.slice(0,p)))
      const [w,s,e,n]=serviceAreaBounds(pickup)
      for(let x=0;x<=20;x++)for(let y=0;y<=20;y++)assert(covered(leaves,[w+(e-w)*x/20,s+(n-s)*y/20]))
    }
  }
})

test('many islands coarsen together rather than silently dropping eastern components',()=>{
  const coordinates=Array.from({length:16},(_,i)=>[ring(-80+i*10,10+i%2,-79.999+i*10,10.001+i%2)])
  const area={type:'MultiPolygon',coordinates},tags=serviceAreaTags({pickup:area}),leaves=leafCells(tags,'pickup')
  for(const [outline] of coordinates){const [w,s,e,n]=serviceAreaBounds({type:'Polygon',coordinates:[outline]});assert(covered(leaves,[(w+e)/2,(s+n)/2]))}
  assert(leaves.length<=64)
})

test('bounds centre is a camera helper and normalized geometry cannot be mutated',()=>{
  const input={type:'Polygon',coordinates:[ring(0,0,10,10),ring(3,3,7,7)]},area=validateServiceArea(input)
  assert.deepEqual(serviceAreaCenter(area),[5,5]);assert.equal(serviceAreaContains(area,serviceAreaCenter(area)),false)
  input.coordinates[0][0][0]=99
  assert.deepEqual(serviceAreaBounds(area),[0,0,10,10])
  assert.throws(()=>{area.coordinates[0][0][0]=99})
  assert.equal(validateServiceArea(area),area)
})
