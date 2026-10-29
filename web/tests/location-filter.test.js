import test from 'node:test'
import assert from 'node:assert/strict'
import {currentPosition,nearbyPoint,isNearby,nearbyViewport,listingMatchesNearby} from '../src/location-filter.ts'

test('nearby location keeps a coarse in-memory point and rejects unusable fixes',()=>{
 assert.deepEqual(nearbyPoint({longitude:24.938765,latitude:60.169876,accuracy:120}),[24.94,60.17])
 for(const coords of [{longitude:181,latitude:60,accuracy:20},{longitude:20,latitude:91,accuracy:20},{longitude:20,latitude:60,accuracy:10001},{longitude:NaN,latitude:60,accuracy:10}])assert.throws(()=>nearbyPoint(coords))
})
test('nearby filter excludes unknown/far listings and handles the antimeridian',()=>{
 assert(isNearby([24.94,60.17],[24.94,60.17]))
 assert(isNearby([24.66,60.21],[24.94,60.17]))
 assert(!isNearby([23.76,61.50],[24.94,60.17]))
 assert(!isNearby(null,[24.94,60.17]))
 assert(isNearby([-179.9,0],[179.9,0]))
 const view=nearbyViewport([24.94,60.17]);assert(view.west<24.94&&view.east>24.94&&view.south<60.17&&view.north>60.17)
})
test('one-shot permission is requested only on explicit invocation and uses low accuracy',async()=>{
 let requests=0
 const geolocation={getCurrentPosition(resolve,reject,options){requests++;assert.deepEqual(options,{enableHighAccuracy:false,timeout:10000,maximumAge:300000});resolve({coords:{longitude:24.94,latitude:60.17}})}}
 assert.equal(requests,0);await currentPosition(geolocation);assert.equal(requests,1)
 await assert.rejects(currentPosition({getCurrentPosition(resolve,reject){reject({code:1})}}),/access is off/)
 await assert.rejects(currentPosition({getCurrentPosition(resolve,reject){reject({code:3})}}),/too long/)
 await assert.rejects(currentPosition(undefined),/unavailable/)
})

test('nearby transport matches exact pickup coverage rather than indexing-cell centres',()=>{
 const pickup={type:'Polygon',coordinates:[[[24,60],[25,60],[25,61],[24,61],[24,60]]]},destination={type:'Polygon',coordinates:[[[25,60],[26,60],[26,61],[25,61],[25,60]]]};
 assert(listingMatchesNearby({serviceAreas:{pickup,destination}},[24.5,60.5]));
 assert(!listingMatchesNearby({serviceAreas:{pickup,destination},coordinates:[25.5,60.5]},[25.5,60.5]));
 assert(listingMatchesNearby({coordinates:[24.94,60.17]},[24.94,60.17]));
});
