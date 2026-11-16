import test from 'node:test';
import assert from 'node:assert/strict';
import {createAreaMemory,neighbourCells,stickyArea} from '../src/map/area-memory.ts';
import {encodeLocationHash} from '../src/map/geohash.ts';

test('every area has eight neighbours that see it back, also across the date line',()=>{
  for(const hash of ['u4pr','ud9w',encodeLocationHash(179.99,10,4),encodeLocationHash(-179.99,-10,4)]){
    const around=neighbourCells(hash);
    assert.equal(around.length,8);assert(!around.includes(hash));
    for(const cell of around){assert.equal(cell.length,4);assert(neighbourCells(cell).includes(hash),`${cell} sees ${hash}`);}
  }
});

test('a new area next to a remembered one stays the remembered one; a distant area does not',()=>{
  const home=encodeLocationHash(24.94,60.17,4),next=neighbourCells(home)[0],far=encodeLocationHash(-9.14,38.72,4);
  assert.equal(stickyArea(home,[home]),home);
  assert.equal(stickyArea(next,[home]),home,'near a border both sides publish one area');
  assert.equal(stickyArea(far,[home]),far);
  assert.equal(stickyArea(encodeLocationHash(24.94,60.17,5),[home]),encodeLocationHash(24.94,60.17,5),'other sizes are left alone');
});

test('the memory is per profile, keeps the latest few areas and ignores bad entries',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  let owner='a';const memory=createAreaMemory(storage,()=>owner);
  for(const hash of ['u4pr','ud9w','ezjm','u60g','gcpv'])memory.remember(hash);
  memory.remember('not a hash');
  assert.deepEqual(memory.areas(),['gcpv','u60g','ezjm','ud9w']);
  owner='b';assert.deepEqual(memory.areas(),[]);
});
