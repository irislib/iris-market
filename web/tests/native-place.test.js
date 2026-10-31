import test from 'node:test';
import assert from 'node:assert/strict';
import {mountNativePlace,cleanNativePlace} from '../src/native-place.ts';

test('private place bridge isolates draft data and clears native coordinates after address edits',()=>{
  const messages=[],values=[];let options,destroyed=0;
  const win=new EventTarget();win.webkit={messageHandlers:{marketMap:{postMessage:v=>messages.push(v)}}};
  globalThis.window=win;globalThis.document={documentElement:{dataset:{}},getElementById:()=>({replaceWith(){}}),querySelectorAll:()=>[]};
  try {
    const api=mountNativePlace({createPicker:settings=>{options=settings;return{element:{},setValue:v=>values.push(v),destroy(){destroyed++}}}});
    assert.deepEqual(messages,[{type:'ready',mode:'place',version:1}]);
    const place={label:'Door',address:'Meeting point',coordinates:[24,60]};api.setValue(place);assert.equal(values.length,1);
    api.setValue({...place,orderId:'private'});assert.equal(values.length,1);
    options.onDraftChange({label:'Door',address:''});assert.deepEqual(messages.at(-1),{type:'place',place:{label:'Door',address:''}});
    let fixes=0,errors=0;options.geolocation.getCurrentPosition(()=>fixes++,()=>errors++);
    const id=messages.at(-1).id;api.setLocation('stale',[24,60]);assert.equal(fixes,0);api.setLocation(id,[181,0]);assert.equal(errors,1);
    options.geolocation.getCurrentPosition(position=>{assert.equal(position.coords.latitude,60);fixes++},()=>errors++);
    api.setLocation(messages.at(-1).id,[24,60]);assert.equal(fixes,1);
    win.dispatchEvent(new Event('pagehide'));assert.equal(destroyed,1);api.setValue(place);assert.equal(values.length,1);
  }finally{delete globalThis.window;delete globalThis.document;}
});
test('private point projections reject unrelated fields, oversized addresses and invalid coordinates',()=>{
  assert.throws(()=>cleanNativePlace({label:'x',address:'x',token:'secret'}));
  assert.throws(()=>cleanNativePlace({label:'x',address:'x'.repeat(501)}));
  assert.throws(()=>cleanNativePlace({label:'x',address:'x',coordinates:[0,NaN]}));
  assert.deepEqual(cleanNativePlace({label:'',address:''}),{label:'',address:''});
});
