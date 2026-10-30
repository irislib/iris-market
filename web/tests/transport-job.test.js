import test from 'node:test';
import assert from 'node:assert/strict';
import {nextTransportStop,stopDirections,transportProgress} from '../src/transport-job.ts';

const job={seller:'seller',status:'accepted',archived:false,shipment:{stops:[
  {id:'previous',status:'completed',courierPubkey:'driver'},
  {id:'other',status:'pending',courierPubkey:'someone-else'},
  {id:'pickup',label:'Passenger pickup',address:'Meeting point',status:'pending',courierPubkey:'driver'},
]}};
test('next stop belongs to this provider and active job only',()=>{
  assert.equal(nextTransportStop(job,'driver').id,'pickup');
  assert.equal(nextTransportStop(job,'seller').id,'other');
  assert.equal(nextTransportStop(job,'outsider'),undefined);
  for(const status of ['requested','delivered','cancelled'])assert.equal(nextTransportStop({...job,status},'driver'),undefined);
  assert.equal(nextTransportStop({...job,archived:true},'driver'),undefined);
  assert.deepEqual(transportProgress(job),{completed:1,total:3});
});
test('directions include only the destination, with safe coordinate validation',()=>{
  const url=new URL(stopDirections({coordinates:[24.94,60.17],address:'Private label',courierPubkey:'SECRET'}));
  assert.equal(url.searchParams.get('destination'),'60.17,24.94');
  assert.equal(url.searchParams.size,2);assert.equal(url.href.includes('SECRET'),false);
  assert.equal(new URL(stopDirections({coordinates:[999,5],address:'Station & north entrance'})).searchParams.get('destination'),'Station & north entrance');
  assert.equal(stopDirections({coordinates:[NaN,5],address:''}),null);
});
