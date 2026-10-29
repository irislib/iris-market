import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {parseServiceAreas,serviceAreaTags,serviceAreaContains,serviceAreaCircle,validateServiceArea} from '../src/service-area.ts'

const fixture=JSON.parse(readFileSync(new URL('../../crates/market-core/fixtures/service-areas-v1.json',import.meta.url),'utf8'))
test('web and Rust share service-area wire, exact indexes and boundary fixtures',()=>{
  assert.equal(fixture.version,1)
  for(const {id,areas,indexes,probes} of fixture.cases){
    const tags=serviceAreaTags(areas)
    assert.deepEqual(parseServiceAreas(tags),areas,id)
    for(const role of ['pickup','destination']){
      assert.deepEqual(tags.filter(t=>t[0]==='g'&&t[2]===role).map(t=>t[1]),indexes[role],`${id} ${role}`)
      for(const probe of probes)assert.equal(serviceAreaContains(areas[role],probe.point),probe[role],`${id} ${role} ${probe.point}`)
    }
    assert(tags.filter(t=>t[0]==='g').every(t=>t.length===3))
  }
})
test('shared malformed geometry fails closed and northern circle coordinates stay stable',()=>{
  for(const {id,geometry} of fixture.invalidGeometries)assert.throws(()=>validateServiceArea(geometry),undefined,id)
  for(const {center,radiusKm,geometry} of fixture.circles)assert.deepEqual(serviceAreaCircle(center,radiusKm),geometry)
})
