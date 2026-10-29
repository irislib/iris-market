import test from 'node:test';
import assert from 'node:assert/strict';
import {setupLongPress} from '../src/long-press.ts';
function fixture(t) {
 t.mock.timers.enable({apis:['setTimeout']});
 const surface=new EventTarget(),control=new EventTarget();control.ownerDocument=surface;
 let opened=0;
 const dispose=setupLongPress(control,()=>opened++);
 const fire=(target,type,props={})=>{const event=new Event(type,{cancelable:true});Object.assign(event,props);target.dispatchEvent(event);return event;};
 const down=()=>fire(control,'pointerdown',{button:0,isPrimary:true,pointerId:1,clientX:20,clientY:20});
 return {surface,control,dispose,fire,down,opened:()=>opened};
}
test('short primary tap preserves click and never opens options',t=>{
 const f=fixture(t);f.down();t.mock.timers.tick(499);f.fire(f.surface,'pointerup',{pointerId:1});
 assert.equal(f.fire(f.control,'click').defaultPrevented,false);t.mock.timers.tick(1000);assert.equal(f.opened(),0);f.dispose();
});
test('long press opens once and consumes only its following click',t=>{
 const f=fixture(t);let clicks=0;
 // Capture listener is registered before the normal action, as in app.ts/setupAI.
 f.control.addEventListener('click',()=>clicks++);
 f.down();t.mock.timers.tick(500);assert.equal(f.opened(),1);
 f.fire(f.control,'contextmenu');assert.equal(f.opened(),1);t.mock.timers.tick(5000);
 f.fire(f.surface,'pointerup',{pointerId:1});assert.equal(f.fire(f.control,'click').defaultPrevented,true);assert.equal(clicks,0);
 f.down();f.fire(f.surface,'pointerup',{pointerId:1});f.fire(f.control,'click');assert.equal(clicks,1);f.dispose();
});
test('drag, cancellation, and early release cancel the pending gesture',t=>{
 for(const [type,props] of [['pointermove',{clientX:31,clientY:20}],['pointercancel',{}],['pointerup',{}]]) {
  const f=fixture(t);f.down();f.fire(f.surface,type,{pointerId:1,...props});t.mock.timers.tick(500);assert.equal(f.opened(),0);f.dispose();t.mock.timers.reset();
 }
});
test('secondary and nonprimary pointers do not start a long press',t=>{
 const f=fixture(t);
 for(const props of [{button:2,isPrimary:true},{button:0,isPrimary:false}]){f.fire(f.control,'pointerdown',{pointerId:1,...props});t.mock.timers.tick(500);}
 assert.equal(f.opened(),0);assert.equal(f.fire(f.control,'contextmenu').defaultPrevented,true);assert.equal(f.opened(),1);f.dispose();
});
test('context menu and Shift F10 open options; ordinary keyboard activation remains a tap',t=>{
 const f=fixture(t);
 assert.equal(f.fire(f.control,'keydown',{key:'F10',shiftKey:true}).defaultPrevented,true);assert.equal(f.opened(),1);
 f.fire(f.control,'keydown',{key:'Enter'});assert.equal(f.fire(f.control,'click').defaultPrevented,false);
 assert.equal(f.fire(f.control,'keydown',{key:'ContextMenu'}).defaultPrevented,true);assert.equal(f.opened(),2);f.dispose();
});
test('disposal removes pending timers and all handlers',t=>{
 const f=fixture(t);f.down();f.dispose();t.mock.timers.tick(2000);f.fire(f.control,'contextmenu');f.fire(f.control,'keydown',{key:'ContextMenu'});f.down();t.mock.timers.tick(1000);
 assert.equal(f.opened(),0);assert.equal(f.fire(f.control,'click').defaultPrevented,false);
});

test('new right clicks reopen options when navigation produced no synthetic click',t=>{
 const f=fixture(t);
 for(let attempt=0;attempt<3;attempt++) {
  f.fire(f.control,'pointerdown',{button:2,isPrimary:true,pointerId:1,clientX:20,clientY:20});
  assert.equal(f.fire(f.control,'contextmenu').defaultPrevented,true);
  assert.equal(f.opened(),attempt+1);
 }
 f.down();f.fire(f.surface,'pointerup',{pointerId:1});assert.equal(f.fire(f.control,'click').defaultPrevented,false);f.dispose();
});
test('independent keyboard options gestures reopen after navigation without a click',t=>{
 const f=fixture(t);
 for(const [index,props] of [{key:'ContextMenu'},{key:'F10',shiftKey:true},{key:'ContextMenu'}].entries()) {
  assert.equal(f.fire(f.control,'keydown',props).defaultPrevented,true);
  assert.equal(f.opened(),index+1);
  // Browsers can dispatch a native contextmenu after the keydown too.
  f.fire(f.control,'contextmenu');assert.equal(f.opened(),index+1);
 }
 f.down();f.fire(f.surface,'pointerup',{pointerId:1});assert.equal(f.fire(f.control,'click').defaultPrevented,false);f.dispose();
});
