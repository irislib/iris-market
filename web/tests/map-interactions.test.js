import test from 'node:test'
import assert from 'node:assert/strict'
import { createListingInteractions, createListingOverlay, mapViewport } from '../src/map/index.ts'

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
    queryRenderedFeatures(point, { layers }) { assert.deepEqual(layers, ['market-cluster-count', 'market-clusters', 'market-pins']); return this.features },
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
  const handlers = new Map(), layers = new Set(); let source, writes = 0
  const map = { on: (name, fn) => handlers.set(name, fn), off() {}, getSource: () => source, addSource(id, options) { source = { ...options, setData() { writes++ } } }, getLayer: id => layers.has(id), addLayer: layer => layers.add(layer.id), setPaintProperty() {} }
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
