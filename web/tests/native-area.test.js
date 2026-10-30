import test from 'node:test';
import assert from 'node:assert/strict';
import {mountNativeArea} from '../src/native-area.ts';
import {serviceAreaCircle} from '../src/service-area.ts';

test('native area bridge sends only draft geometry, requests one fix explicitly and rejects stale/invalid replies',()=>{
  const messages=[],values=[];let options,destroyed=0;
  const win=new EventTarget();win.webkit={messageHandlers:{marketMap:{postMessage:value=>messages.push(value)}}};
  globalThis.window=win;globalThis.document={documentElement:{dataset:{}},getElementById:()=>({replaceWith(){},hidden:false}),querySelector:()=>({hidden:false})};
  const api=mountNativeArea({createPicker:settings=>{options=settings;return{element:{},setValue:v=>values.push(v),show(){},destroy(){destroyed++}}}});
  assert.deepEqual(messages,[{type:'ready',mode:'area',version:1}]);
  const area=serviceAreaCircle([24,60],10);api.setValue({pickup:area,destination:area});assert.equal(values.length,1);
  api.setValue({pickup:area,destination:area,token:'forbidden'});assert.equal(values.length,1);
  let fixes=0,errors=0;options.geolocation.getCurrentPosition(()=>fixes++,()=>errors++);const id=messages.at(-1).id;
  api.setLocation('stale',[24,60]);assert.equal(fixes,0);api.setLocation(id,[200,60]);assert.equal(errors,1);
  options.geolocation.getCurrentPosition(position=>{fixes++;assert.equal(position.coords.longitude,24)},()=>errors++);
  api.setLocation(messages.at(-1).id,[24,60]);assert.equal(fixes,1);
  options.onChange({pickup:area,destination:area});api.setValue({destination:area,pickup:area});assert.equal(values.length,1,'native echoes must not reset the editor controls');assert.deepEqual(Object.keys(messages.at(-1)).sort(),['areas','type']);
  win.dispatchEvent(new Event('pagehide'));assert.equal(destroyed,1);api.setValue(null);assert.equal(values.length,1);
  delete globalThis.window;delete globalThis.document;
});
