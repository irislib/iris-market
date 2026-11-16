import test from 'node:test';
import assert from 'node:assert/strict';
import {window} from './support/dom.mjs';
const {setLinkedText}=await import('../src/translation-content.ts');

test('profile descriptions link web addresses and Nostr profiles as plain DOM',()=>{
  const p=window.document.createElement('p');
  setLinkedText(p,'Shop: https://example.com/shop. Friend nostr:npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq <b>bold</b>');
  const links=[...p.querySelectorAll('a')];
  assert.equal(links.length,2);
  assert.equal(links[0].getAttribute('href'),'https://example.com/shop');assert.equal(links[0].rel,'noopener noreferrer nofollow');
  assert.equal(links[1].getAttribute('href'),'/npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq');
  assert.ok(p.textContent.endsWith('<b>bold</b>'));assert.equal(p.querySelector('b'),null);
});
