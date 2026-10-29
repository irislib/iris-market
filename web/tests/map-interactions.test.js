import test from 'node:test'
import assert from 'node:assert/strict'
import { createListingInteractions, createListingOverlay, listingFeatures, listingAreaFeatures, listingMapBounds, listingIntersectsViewport, mapViewport } from '../src/map/index.ts'
import { GeoJSONVT } from '@maplibre/geojson-vt'
import { GeoJSONWrapper, fromVectorTileJs } from '@maplibre/vt-pbf'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'

const listing = (id, coordinates = [24.94, 60.17]) => ({ id, title: `Listing ${id}`, coordinates })
const pin = item => ({ type: 'Feature', properties: { id: item.id }, geometry: { type: 'Point', coordinates: item.coordinates } })
const cluster = (layer = 'market-cluster-count') => ({ layer: { id: layer }, properties: { cluster_id: 7, point_count: 2 }, geometry: { type: 'Point', coordinates: [24.94, 60.17] } })
const tick = () => new Promise(resolve => setImmediate(resolve))
class Element {
  constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.listeners = new Map(); this.attributes = new Map() }
  setAttribute(name, value) { this.attributes.set(name, value) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  removeAttribute(name) { this.attributes.delete(name) }
  append(...elements) { this.children.push(...elements) }
  addEventListener(name, fn) { this.listeners.set(name, fn) }
  removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name) }
  focus() { this.focused = true }
  contains(target) { return target===this||this.children.some(child=>child.contains(target)) }
  get firstElementChild() { return this.children[0] }
}
function fixture(items = [listing('a'), listing('b', [25, 60.2])]) {
  const handlers = new Map(), canvas = new Element('canvas'), selected = [], errors = [], popups = [], eases = [], featureStates = []
  const source = { getClusterExpansionZoom: async id => { assert.equal(id, 7); return 10 }, getClusterLeaves: async (id, limit, offset) => { assert.equal(id, 7); assert.equal(limit, 1000); assert.equal(offset, 0); return items.map(pin) } }
  const bounds = { getWest: () => 24, getSouth: () => 60, getEast: () => 26, getNorth: () => 61, contains: coordinates => coordinates[0] >= 24 && coordinates[0] <= 26 }
  const map = {
    zoom: 5, features: [], getCanvas: () => canvas, getLayer: () => true, getSource: () => source,
    getZoom() { return this.zoom }, getMaxZoom: () => 18, getBounds: () => bounds, getCenter: () => [25, 60.5],
    on: (name, fn) => handlers.set(name, fn), off: (name, fn) => { if (handlers.get(name) === fn) handlers.delete(name) },
    queryRenderedFeatures(point, { layers }) { assert.deepEqual(layers, ['market-cluster-count', 'market-clusters', 'market-pins', 'market-service-area-outline', 'market-service-area-fill']); return this.features },
    easeTo: value => eases.push(value),
    setFeatureState: (target, state) => featureStates.push({ target, state }),
  }
  const document=new Element('document');document.createElement=tag=>new Element(tag)
  const api = createListingInteractions(map, { getListings: () => items, onSelect: item => selected.push(item), onError: error => errors.push(error), document, createPopup: () => {
    const popup = { setLngLat(value) { this.coordinates = value; return this }, setDOMContent(value) { this.content = value; return this }, addTo(value) { assert.equal(value, map); return this }, remove() { this.removed = true } }
    popups.push(popup); return popup
  } })
  return { api, map, canvas, document, source, selected, errors, popups, eases, handlers, featureStates, hover(features) { map.features = features; handlers.get('mousemove')({ point: { x: 20, y: 20 } }) }, async click(features) { map.features = features; handlers.get('click')({ point: { x: 20, y: 20 } }); await tick() } }
}

for (const layer of ['market-clusters', 'market-cluster-count']) test(`cluster ${layer} hit expands once using current Promise API`, async () => {
  const f = fixture(); await f.click([cluster(layer), cluster()]);
  assert.deepEqual(f.eases, [{ center: [24.94, 60.17], zoom: 10 }]); assert.equal(f.popups.length, 0); assert.equal(f.selected.length, 0); assert.deepEqual(f.errors, []); f.api.destroy()
})

test('coincident cluster opens keyboard-focusable choices instead of useless zoom', async () => {
  const items = [listing('a'), listing('b')], f = fixture(items); await f.click([cluster()]);
  assert.equal(f.eases.length, 0); const choices = f.popups[0].content.children[1]
  assert.equal(choices.children.length, 2); assert.equal(choices.firstElementChild.focused, true)
  assert.equal(choices.children[1].textContent, 'Listing b'); choices.children[1].onclick()
  assert.deepEqual(f.selected, [items[1]]); assert.equal(f.popups[0].removed, true); f.api.destroy()
})

test('max-zoom clusters and overlapping unclustered pins allow choosing every listing', async () => {
  const f = fixture(); f.map.zoom = 18; await f.click([cluster()]); assert.equal(f.popups.length, 1); assert.equal(f.eases.length, 0)
  await f.click([pin(listing('a')), pin(listing('b'))]); assert.equal(f.popups.length, 2); assert.equal(f.popups[0].removed, true)
  f.popups[1].content.children[1].children[0].onclick(); assert.equal(f.selected[0].id, 'a'); f.api.destroy()
})

test('single pin opens the shared choices popover and only choosing its listing opens detail', async () => {
  const item = listing('a'), f = fixture([item]); await f.click([pin(item), pin(item)])
  assert.deepEqual(f.selected, []);assert.equal(f.popups.length,1);assert.equal(f.eases.length,0)
  const content=f.popups[0].content,choices=content.children[1]
  assert.equal(content.children[0].textContent,'1 listing');assert.equal(content.getAttribute('role'),'dialog');assert.equal(choices.children.length,1);assert.equal(choices.firstElementChild.focused,true)
  choices.firstElementChild.onclick();assert.deepEqual(f.selected,[item]);assert.equal(f.popups[0].removed,true);f.api.destroy()
})

test('single-pin choices dismiss outside, on Escape or Close with appropriate focus',async()=>{
  const item=listing('a'),f=fixture([item])
  await f.click([pin(item)]);const content=f.popups[0].content
  f.document.listeners.get('pointerdown')({target:content.children[1].firstElementChild});assert.equal(f.popups[0].removed,undefined)
  f.document.listeners.get('pointerdown')({target:new Element('button')});assert.equal(f.popups[0].removed,true);assert.equal(f.canvas.focused,undefined)
  await f.click([pin(item)]);f.document.listeners.get('keydown')({key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(f.popups[1].removed,true);assert.equal(f.canvas.focused,true)
  f.canvas.focused=false;await f.click([pin(item)]);f.popups[2].content.children[2].onclick();assert.equal(f.popups[2].removed,true);assert.equal(f.canvas.focused,true)
  f.canvas.focused=false;await f.click([pin(item)]);f.document.listeners.get('focusin')({target:new Element('a')});assert.equal(f.popups[3].removed,true);assert.equal(f.canvas.focused,false)
  assert.equal(f.selected.length,0);f.api.destroy();assert.equal(f.document.listeners.size,0)
})

test('empty-map click dismisses a popover and an outside action cancels late cluster choices',async()=>{
  const item=listing('a'),f=fixture([item]);await f.click([pin(item)]);await f.click([]);assert.equal(f.popups[0].removed,true)
  let release;f.source.getClusterExpansionZoom=()=>new Promise(resolve=>{release=resolve});f.map.features=[cluster()];f.handlers.get('click')({point:{}})
  f.document.listeners.get('pointerdown')({target:new Element('button')});release(10);await tick();assert.equal(f.popups.length,1);assert.equal(f.eases.length,0);f.api.destroy()
})

test('Enter on focused map lists visible items; Escape closes and restores map focus', () => {
  const f = fixture([listing('a'), listing('b'), listing('far', [0, 0])]); let prevented = false
  f.canvas.listeners.get('keydown')({ target: f.canvas, key: 'Enter', preventDefault() { prevented = true } })
  assert.equal(prevented, true); const content = f.popups[0].content; assert.equal(content.children[1].children.length, 2)
  content.listeners.get('keydown')({ key: 'Escape', stopPropagation() {} }); assert.equal(f.popups[0].removed, true); assert.equal(f.canvas.focused, true)
  f.api.destroy(); assert.equal(f.canvas.listeners.size, 0); assert.equal(f.handlers.size, 0); assert.equal(f.canvas.getAttribute('aria-label'), null)
})

test('late cluster results cannot act after listings change or map closes', async () => {
  for (const action of ['invalidate', 'destroy']) {
    const f = fixture(); let resolveZoom; f.source.getClusterExpansionZoom = () => new Promise(resolve => { resolveZoom = resolve })
    f.map.features = [cluster()]; f.handlers.get('click')({ point: {} }); f.api[action](); resolveZoom(10); await tick()
    assert.equal(f.eases.length, 0); assert.equal(f.popups.length, 0); assert.deepEqual(f.errors, []); f.api.destroy()
  }
})

test('unchanged overlays do not rebuild the clustering index', () => {
  const handlers = new Map(), layers = new Set(), sources=new Map(); let writes = 0
  const map = { on: (name, fn) => handlers.set(name, fn), off() {}, getSource: id => sources.get(id), addSource(id, options) { sources.set(id,{ ...options, setData() { writes++ } }) }, getLayer: id => layers.has(id), addLayer: layer => layers.add(layer.id), setPaintProperty() {} }
  const overlay = createListingOverlay(map, [listing('a')]); handlers.get('style.load')(); overlay.setListings([listing('a')]); handlers.get('load')()
  assert.equal(writes, 0); overlay.setListings([listing('b')]); assert.equal(writes, 1); overlay.destroy()
})

test('viewport reports finite geographic bounds and rejects invalid camera state', () => {
  const f = fixture(); assert.deepEqual(mapViewport(f.map), { west: 24, south: 60, east: 26, north: 61, zoom: 5 })
  f.map.zoom = NaN; assert.equal(mapViewport(f.map), null); f.api.destroy()
})

test('hover grows only the hit pin and resets the previous pin without changing selection', () => {
  const f = fixture()
  f.hover([pin(listing('a'))]); f.hover([pin(listing('a'))]); f.hover([pin(listing('b'))])
  assert.equal(f.canvas.style.cursor, 'pointer')
  assert.deepEqual(f.featureStates.map(({target, state}) => [target.id, state.hover]), [['a', true], ['a', false], ['b', true]])
  assert.equal(f.selected.length, 0)
  f.canvas.listeners.get('mouseleave')()
  assert.deepEqual(f.featureStates.at(-1), { target: { source: 'market-listings', id: 'b' }, state: { hover: false } })
  assert.equal(f.canvas.style.cursor, '')
  f.api.destroy()
})

test('canonical pin identities survive actual vector-tile integer coercion without shared hover', () => {
  const author='a'.repeat(64), other='123'+'b'.repeat(61)
  const items=[listing(`${author}:one`,[10,10]),listing(`${author}:two`,[15,10]),listing(`${other}:three`,[20,10]),listing(`${other}:four`,[25,10])]
  // This is the installed MapLibre worker's GeoJSON -> PBF -> feature path.
  // PBF only has numeric IDs: without property promotion these addresses collide.
  const tile=new GeoJSONVT(listingFeatures(items),{maxZoom:18}).getTile(0,0,0)
  const decoded=Object.values(new VectorTile(new PbfReader(fromVectorTileJs(new GeoJSONWrapper(tile.features)))).layers)[0]
  const features=Array.from({length:decoded.length},(_,i)=>decoded.feature(i))
  assert.deepEqual(features.map(feature=>feature.id),[0,0,123,123])
  let options;const handlers=new Map()
  const overlay=createListingOverlay({on:(name,fn)=>handlers.set(name,fn),off(){},getSource(){},addSource(id,value){if(id==='market-listings')options=value},getLayer(){},addLayer(){},setPaintProperty(){}},items)
  handlers.get('style.load')();assert.equal(options.promoteId,'id')
  assert.deepEqual(features.map(feature=>feature.properties[options.promoteId]),items.map(item=>item.id))
  const f=fixture(items)
  for(const feature of features)f.hover([feature])
  const expected=items.flatMap((item,i)=>i?[[items[i-1].id,false],[item.id,true]]:[[item.id,true]])
  assert.deepEqual(f.featureStates.map(({target,state})=>[target.id,state.hover]),expected)
  assert.equal(f.selected.length,0);f.api.destroy();overlay.destroy()
})

test('overlapping pins hover only the front hit and never collide with numeric cluster IDs', () => {
  const a=listing(`7${'a'.repeat(63)}:a`), b=listing(`7${'a'.repeat(63)}:b`), f=fixture([a,b])
  const first={...pin(a),id:7}, second={...pin(b),id:7}
  f.hover([first,second]);f.hover([second,first]);f.hover([cluster(),second])
  assert.deepEqual(f.featureStates.map(({target,state})=>[target.id,state.hover]),[[a.id,true],[a.id,false],[b.id,true],[b.id,false],[7,true]])
  assert.equal(f.selected.length,0);f.api.destroy()
})

test('missing numeric tile ID does not suppress a canonical pin and duplicate records make one feature', () => {
  const item=listing(`${'f'.repeat(64)}:bike`),f=fixture([item])
  f.hover([{...pin(item),id:NaN}]);assert.equal(f.featureStates.at(-1)?.target.id,item.id)
  assert.equal(listingFeatures([item,{...item,coordinates:[25,61]}]).features.length,1)
  f.api.destroy()
})

test('a source temporarily absent during style changes does not poison the next hover', () => {
  const item=listing('a'),f=fixture([item]),getSource=f.map.getSource
  f.map.getSource=()=>undefined;f.hover([pin(item)]);assert.equal(f.featureStates.length,0)
  f.map.getSource=getSource;f.hover([pin(item)]);assert.equal(f.featureStates.at(-1)?.state.hover,true)
  f.api.destroy()
})

test('cluster hover keeps click expansion and clears on style, camera, data and teardown', async () => {
  const f = fixture()
  f.hover([cluster()]); await f.click([cluster()]); assert.equal(f.eases.length, 1)
  for (const reset of [() => f.handlers.get('style.load')(), () => f.handlers.get('movestart')(), () => f.api.invalidate(), () => f.api.destroy()]) {
    f.hover([cluster()]); reset()
    assert.equal(f.featureStates.at(-1).target.id, 7); assert.equal(f.featureStates.at(-1).state.hover, false); assert.equal(f.canvas.style.cursor, '')
  }
  assert.equal(f.handlers.size, 0)
})

test('listing layer paint uses a modest hover expansion for pins and clusters', () => {
  const handlers = new Map(), layers = new Map()
  const map = { on: (name, fn) => handlers.set(name, fn), off() {}, getSource: () => undefined, addSource() {}, getLayer: id => layers.get(id), addLayer: layer => layers.set(layer.id, layer), setPaintProperty() {} }
  const overlay = createListingOverlay(map, [listing('a')]); handlers.get('style.load')()
  for (const name of ['market-pins', 'market-clusters']) {
    const expression = layers.get(name).paint['circle-radius']
    assert.deepEqual(expression.slice(0, 2), ['case', ['boolean', ['feature-state', 'hover'], false]])
    assert.ok(expression[2] > expression[3] && expression[2] <= expression[3] * 1.15)
  }
  overlay.destroy()
})

const areaBox=(w,s,e,n)=>({type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]})
const areaListing=(id, pickup=areaBox(24,60,26,61), destination=areaBox(30,60,31,61))=>({id,title:`Area ${id}`,serviceAreas:{pickup,destination}})
const areaHit=(item,role='pickup')=>({...listingAreaFeatures([item]).features.find(f=>f.properties.role===role),source:'market-service-areas',layer:{id:'market-service-area-fill'}})

test('service areas have separate stable identities and fit bounds without fictional pins',()=>{
  const item=areaListing('same:id'),features=listingAreaFeatures([item,item]).features
  assert.equal(features.length,2);assert.equal(listingFeatures([item]).features.length,0)
  assert.equal(new Set(features.map(f=>f.properties.featureKey)).size,2)
  assert(features.every(f=>f.properties.id===item.id))
  assert.deepEqual(listingMapBounds([item,listing('actual-point',[10,50])]),[10,50,31,61])
  assert.equal(listingAreaFeatures([{...item,serviceAreas:{pickup:item.serviceAreas.pickup,destination:{type:'Point',coordinates:[0,0]}}}]).features.length,0)
})

test('area and point hits for one listing open one choice anchored at the area click',async()=>{
  const item=areaListing('same:id'),f=fixture([item,item])
  f.map.features=[areaHit(item),areaHit(item,'destination'),pin({...item,coordinates:[25,60.5]})]
  f.handlers.get('click')({point:{x:20,y:20},lngLat:{lng:25.4,lat:60.4}});await tick()
  assert.deepEqual(f.popups[0].coordinates,[25.4,60.4]);assert.equal(f.popups[0].content.children[1].children.length,1)
  f.popups[0].content.children[1].children[0].onclick();assert.deepEqual(f.selected,[item]);f.api.destroy()
})

test('area hover never changes point feature state and switches only the front role',()=>{
  const item=areaListing('same:id'),f=fixture([item]),pickup=areaHit(item),destination=areaHit(item,'destination')
  f.hover([pickup,destination]);f.hover([destination,pickup]);f.hover([pin({...item,coordinates:[25,60.5]})])
  assert.deepEqual(f.featureStates.map(({target,state})=>[target.source,target.id,state.hover]),[
    ['market-service-areas',pickup.properties.featureKey,true],['market-service-areas',pickup.properties.featureKey,false],
    ['market-service-areas',destination.properties.featureKey,true],['market-service-areas',destination.properties.featureKey,false],
    ['market-listings',item.id,true]])
  f.api.destroy()
})

test('keyboard choices include intersecting areas but exclude a viewport wholly inside a hole',()=>{
  const containing=areaListing('containing',areaBox(20,55,30,65),areaBox(40,10,41,11))
  const crossing=areaListing('crossing',areaBox(10,60.2,40,60.8),areaBox(40,10,41,11))
  const hole=areaListing('hole',{type:'Polygon',coordinates:[areaBox(20,55,30,65).coordinates[0],areaBox(23,59,27,62).coordinates[0]]},areaBox(40,10,41,11))
  const f=fixture([containing,crossing,hole,containing])
  f.canvas.listeners.get('keydown')({target:f.canvas,key:'Enter',preventDefault(){}})
  const choices=f.popups[0].content.children[1].children
  assert.deepEqual(choices.map(c=>c.textContent),['Area containing','Area crossing'])
  const edge=areaListing('date-line-edge',areaBox(179.6,10,179.9,11),areaBox(178,10,179,11))
  assert.equal(listingIntersectsViewport(edge,{west:179.5,east:-179.5,south:9,north:12,zoom:5}),true)
  assert.equal(listingIntersectsViewport(edge,{west:-10,east:10,south:9,north:12,zoom:5}),false)
  f.api.destroy()
})

test('invalidating a changed area closes its popup and resets only its own hover',async()=>{
  const item=areaListing('area'),f=fixture([item]);f.hover([areaHit(item)]);await f.click([areaHit(item)])
  f.api.invalidate();assert.equal(f.popups[0].removed,true)
  assert.deepEqual(f.featureStates.at(-1),{target:{source:'market-service-areas',id:areaHit(item).properties.featureKey},state:{hover:false}})
  f.api.destroy()
})
