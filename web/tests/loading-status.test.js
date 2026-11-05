import test from 'node:test';
import assert from 'node:assert/strict';
import {setLoadingStatus} from '../src/loading-status.ts';
test('each pending request resets its reveal, while results and errors clear the delay',()=>{
  const flushed=[];const node={dataset:{},textContent:'',getAnimations(){flushed.push(this.dataset.loadingStatus);return []}};
  setLoadingStatus(node,'Loading profile…',true);
  assert.equal(node.dataset.loadingStatus,'pending');
  setLoadingStatus(node,'Loading another profile…',true);
  assert.deepEqual(flushed,['ready','ready']);
  setLoadingStatus(node,'Could not load this profile.');
  assert.equal(node.dataset.loadingStatus,'ready');assert.equal(node.textContent,'Could not load this profile.');
  setLoadingStatus(node,'Loading…',true);setLoadingStatus(node,'');
  assert.equal(node.dataset.loadingStatus,'ready');assert.equal(node.textContent,'');
});
