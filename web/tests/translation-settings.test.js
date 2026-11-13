import test from 'node:test';
import assert from 'node:assert/strict';
import {window} from './support/dom.mjs';
import {flushSync} from 'svelte';

Object.defineProperty(globalThis,'localStorage',{value:window.localStorage,configurable:true});
Object.defineProperty(navigator,'languages',{value:['en-GB','fi-FI'],configurable:true});
const {translationSettings}=await import('../src/translation.ts');
const select=(node,value)=>{node.value=value;node.dispatchEvent(new window.Event('change',{bubbles:true}));flushSync();};

test('translation settings show device defaults and persist reader choices locally',()=>{
  const box=translationSettings();document.body.append(box);
  assert.equal(box.className,'translation-settings');assert.equal(box.querySelector('h3').textContent,'Translation');
  const [auto,target,picker]=[box.querySelector('input'),...box.querySelectorAll('select')];
  assert.equal(auto.checked,false);assert.equal(target.value,'');assert.match(target.options[0].textContent,/\(device\)$/);
  assert.equal(picker.value,'');assert.equal(picker.options[0].textContent,'Add a language…');
  const read=()=>[...box.querySelectorAll('.translation-read-languages button')].map(button=>button.getAttribute('aria-label'));
  assert.equal(read().length,1,'device languages seed the languages I read');
  assert.equal([...picker.options].some(option=>option.value==='fi-FI'),false,'known languages are not offered again');
  select(picker,'sv');assert.equal(read().length,2);assert.equal(picker.value,'');
  assert.deepEqual(JSON.parse(window.localStorage.getItem('market-translation-v1')).read,['fi-FI','sv']);
  box.querySelector('.translation-read-languages button:last-child').click();flushSync();assert.equal(read().length,1);
  select(target,'de');assert.equal(target.value,'de');
  auto.checked=true;auto.dispatchEvent(new window.Event('change',{bubbles:true}));flushSync();
  assert.equal(JSON.parse(window.localStorage.getItem('market-translation-v1')).auto,true);
  assert.equal(box.querySelector('p.small.muted').textContent,'On-device translation is unavailable in this browser.');
});
