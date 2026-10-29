import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTheme } from '../src/theme.ts';
import { setupHeaderMenu } from '../src/menu.ts';

class Element extends EventTarget {
  constructor() { super(); this.children=[]; this.dataset={}; this.attributes=new Map(); this.hidden=false; }
  append(...children) { for (const child of children) { child.parent=this; this.children.push(child); } }
  contains(child) { return child===this || this.children.some(node=>node.contains(child)); }
  setAttribute(name,value) { this.attributes.set(name,String(value)); }
  focus() { document.activeElement=this; emit(document,'focusin',{target:this}); }
  closest(selector) {
    if (selector==='[data-menu-dismiss]' && this.dismiss) return this;
    if (selector==='[role="radiogroup"]' && this.group) return this;
    return this.parent?.closest(selector) ?? null;
  }
  querySelectorAll() { return this.children; }
  querySelector() { return this.children[0]; }
}
function emit(target,type,properties={}) {
  const event=new Event(type,{cancelable:true});
  for (const [key,value] of Object.entries(properties)) Object.defineProperty(event,key,{value});
  target.dispatchEvent(event); return event;
}
function fixture({mode='system',dark=false,storageBlocked=false}={}) {
  const trigger=new Element(),panel=new Element(),settings=new Element(),group=new Element(),outside=new Element(),legacy=new Element(),select=new Element();
  settings.dismiss=true;group.group=true;panel.hidden=true;panel.append(settings,group);
  const segments=['light','dark','system'].map(value=>{const button=new Element();button.dataset.themePreference=value;return button;});group.append(...segments);
  const document=new EventTarget();document.activeElement=outside;document.documentElement={dataset:{appearance:mode}};
  document.getElementById=id=>({'header-menu-button':trigger,'header-menu':panel}[id]);
  document.querySelectorAll=selector=>selector==='.theme-select'?[select]:selector==='.theme-toggle'?[legacy]:segments;
  const window=new EventTarget(),media=new EventTarget(),stored=[];media.matches=dark;
  Object.assign(globalThis,{document,window,matchMedia:()=>media,localStorage:{setItem(key,value){if(storageBlocked)throw Error('Blocked');stored.push([key,value]);}}});
  const theme=setupTheme(),menu=setupHeaderMenu();
  return{trigger,panel,settings,group,outside,segments,legacy,select,document,window,media,stored,theme,menu,close(){menu.destroy();theme.destroy();}};
}

test('menu opens to Settings, Escape restores focus, and outside interactions dismiss without stealing focus',()=>{
  const f=fixture();emit(f.trigger,'click');assert.equal(f.panel.hidden,false);assert.equal(f.trigger.attributes.get('aria-expanded'),'true');assert.equal(f.document.activeElement,f.settings);
  emit(f.document,'keydown',{key:'Escape'});assert.equal(f.panel.hidden,true);assert.equal(f.document.activeElement,f.trigger);
  emit(f.trigger,'keydown',{key:'ArrowDown'});assert.equal(f.panel.hidden,false);
  emit(f.document,'pointerdown',{target:f.segments[1]});assert.equal(f.panel.hidden,false);
  f.outside.focus();assert.equal(f.panel.hidden,true);assert.equal(f.document.activeElement,f.outside);
  emit(f.trigger,'click');emit(f.document,'pointerdown',{target:f.outside});assert.equal(f.panel.hidden,true);f.close();
});

test('settings dismisses before routing and a theme choice keeps the menu open',()=>{
  const f=fixture();emit(f.trigger,'click');emit(f.segments[1],'click');emit(f.panel,'click',{target:f.segments[1]});
  assert.equal(f.theme.get(),'dark');assert.equal(f.panel.hidden,false);
  let route=false;f.panel.addEventListener('click',()=>{route=true;assert.equal(f.panel.hidden,true);});
  emit(f.panel,'click',{target:f.settings});assert.equal(route,true);assert.equal(f.document.activeElement,f.trigger);f.close();
});

test('existing preference is preserved; radio arrow keys select and persist exactly one mode',()=>{
  const f=fixture({mode:'dark'});assert.deepEqual(f.stored,[]);assert.equal(f.segments[1].attributes.get('aria-checked'),'true');assert.equal(f.segments[1].tabIndex,0);
  const event=emit(f.segments[1],'keydown',{key:'ArrowRight'});assert.equal(event.defaultPrevented,true);assert.equal(f.theme.get(),'system');assert.equal(f.document.activeElement,f.segments[2]);
  assert.deepEqual(f.stored,[['market-appearance','system']]);assert.deepEqual(f.segments.map(button=>button.attributes.get('aria-checked')),['false','false','true']);
  emit(f.segments[2],'keydown',{key:'Home'});assert.equal(f.theme.get(),'light');emit(f.segments[0],'keydown',{key:'ArrowLeft'});assert.equal(f.theme.get(),'system');f.close();
});

test('system follows device appearance without replacing the saved preference; manual mode ignores device changes',()=>{
  const f=fixture({dark:true});let changed=0;f.window.addEventListener('market-themechange',()=>changed++);
  assert.equal(f.theme.get(),'system');assert.equal(f.legacy.dataset.dark,'true');f.media.matches=false;emit(f.media,'change');
  assert.equal(changed,1);assert.equal(f.legacy.dataset.dark,'false');assert.equal(f.segments[2].attributes.get('aria-checked'),'true');assert.deepEqual(f.stored,[]);
  f.theme.set('light');f.media.matches=true;emit(f.media,'change');assert.equal(changed,2);assert.equal(f.legacy.dataset.dark,'false');f.close();
});

test('legacy download-page controls and cross-tab preference updates stay in sync',()=>{
  const f=fixture();emit(f.legacy,'click');assert.equal(f.theme.get(),'dark');assert.equal(f.select.value,'dark');
  f.select.value='light';emit(f.select,'change');assert.equal(f.segments[0].attributes.get('aria-checked'),'true');
  const before=f.stored.length;emit(f.window,'storage',{key:'market-appearance',newValue:'system'});assert.equal(f.theme.get(),'system');assert.equal(f.stored.length,before);
  emit(f.window,'storage',{key:'unrelated',newValue:'dark'});assert.equal(f.theme.get(),'system');f.close();
});

test('blocked storage still changes appearance and disposal removes global menu listeners',()=>{
  const f=fixture({storageBlocked:true,mode:'invalid'});assert.equal(f.theme.get(),'system');f.theme.set('dark');assert.equal(f.theme.get(),'dark');
  emit(f.trigger,'click');f.close();assert.equal(f.panel.hidden,true);emit(f.trigger,'click');assert.equal(f.panel.hidden,true);
  emit(f.window,'storage',{key:'market-appearance',newValue:'light'});assert.equal(f.theme.get(),'dark');
});
