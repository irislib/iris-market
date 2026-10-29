import test from 'node:test'
import assert from 'node:assert/strict'
import {createUserLocationStore,USER_LOCATION_KEY,coarseArea} from '../src/user-location-store.ts'
const storage=()=>{const data=new Map();return{data,getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}}
const fix={coords:{longitude:24.938765,latitude:60.169876,accuracy:12}}
test('manual preference persists only coarse coordinates and a bounded label',()=>{
 const disk=storage(),store=createUserLocationStore({storage:disk});store.choose([24.938765,60.169876],' Helsinki ')
 assert.deepEqual(JSON.parse(disk.data.get(USER_LOCATION_KEY)),{point:[24.94,60.17],label:'Helsinki'})
 assert.deepEqual(createUserLocationStore({storage:disk}).point(),[24.94,60.17]);store.clear();assert.equal(disk.data.size,0)
 assert.throws(()=>coarseArea([181,0]));assert.throws(()=>coarseArea([0,NaN]))
})
test('automatic GPS only runs for existing granted permission and never persists fixes',async()=>{
 for(const state of ['prompt','denied','granted']) {
  const disk=storage();let calls=0
  const store=createUserLocationStore({storage:disk,permissions:{query:async()=>({state})},geolocation:{getCurrentPosition(resolve){calls++;resolve(fix)}}})
  await store.locate();assert.equal(calls,state==='granted'?1:0);assert.equal(disk.data.size,0)
  assert.deepEqual(store.point(),state==='granted'?[24.94,60.17]:null)
 }
})
test('manual choice defeats an older GPS callback and keeps its fallback when GPS fails',async()=>{
 const disk=storage();let resolveGPS
 const store=createUserLocationStore({storage:disk,permissions:{query:async()=>({state:'granted'})},geolocation:{getCurrentPosition(resolve){resolveGPS=resolve}}})
 const pending=store.locate();await Promise.resolve();store.choose([10.1234,20.5678],'My area');resolveGPS(fix);assert.equal(await pending,false);assert.deepEqual(store.point(),[10.12,20.57])
 const fail=createUserLocationStore({storage:disk,geolocation:{getCurrentPosition(resolve,reject){reject({code:1})}}});assert.equal(await fail.locate(true),false);assert.deepEqual(fail.point(),[10.12,20.57])
})
test('device fix overrides persisted manual area in memory while reload restores fallback',async()=>{
 const disk=storage(),store=createUserLocationStore({storage:disk,geolocation:{getCurrentPosition(resolve){resolve(fix)}}});store.choose([10,20]);const before=disk.data.get(USER_LOCATION_KEY)
 await store.locate(true);assert.deepEqual(store.point(),[24.94,60.17]);assert.equal(disk.data.get(USER_LOCATION_KEY),before);assert.deepEqual(createUserLocationStore({storage:disk}).point(),[10,20])
})
test('invalid storage, permission failures, preview and disposal stay quiet',async()=>{
 const disk=storage();disk.setItem(USER_LOCATION_KEY,'{"point":[999,0]}');let calls=0,changes=0
 const store=createUserLocationStore({storage:disk,permissions:{query:async()=>{throw Error()}},onChange:()=>changes++});assert.equal(store.point(),null);assert.equal(await store.locate(),false);store.dispose();store.choose([0,0]);assert.equal(changes,0)
 const preview=createUserLocationStore({storage:disk,isPreview:true,geolocation:{getCurrentPosition(){calls++}}});assert.equal(await preview.locate(true),false);preview.choose([0.12345,0]);assert.equal(calls,0);assert.equal(disk.getItem(USER_LOCATION_KEY),'{"point":[999,0]}')
})
