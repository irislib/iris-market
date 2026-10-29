import test from 'node:test';
import assert from 'node:assert/strict';
import {descriptionNodes,safeDescriptionUrl,renderDescription} from '../src/description.ts';
const flatten=nodes=>nodes.flatMap(node=>[node,...flatten(node.children||[])]);
test('NIP99 descriptions support plain text, paragraphs, headings, lists, emphasis, quotes and code',()=>{
  const nodes=flatten(descriptionNodes('# Desk\n\n**Oak** with *drawers*.\n\n- First\n- Second\n\n> Pickup\n\n```\n<script>literal</script>\n```'));
  for(const tag of ['h3','p','strong','em','ul','li','blockquote','pre','code'])assert.ok(nodes.some(node=>node.tag===tag),tag);
  assert.ok(nodes.some(node=>node.text==='<script>literal</script>'));
});
test('raw HTML remains literal text, with no event handlers or arbitrary tags',()=>{
  const nodes=flatten(descriptionNodes('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))'));
  assert.equal(nodes.some(node=>['script','img','a'].includes(node.tag)),false);
  assert.ok(nodes.some(node=>node.text?.includes('<script>')));
});
test('links reject active URLs, credentials, relative paths and control-character schemes',()=>{
  for(const href of ['javascript:alert(1)','data:text/html,hi','https://a:b@example.com','//evil.test','/api','https:\\evil.test','java\nscript:alert(1)','htree://unhandled','nostr:unhandled'])assert.equal(safeDescriptionUrl(href),null);
  const nodes=flatten(descriptionNodes('[Document](https://example.com/file.pdf) [bad](javascript&#58;alert%281%29)'));
  const links=nodes.filter(node=>node.tag==='a');assert.equal(links.length,1);assert.equal(links[0].attributes.href,'https://example.com/file.pdf');assert.match(links[0].attributes.rel,/noopener/);
});
test('Markdown photos use the configured proxy and never accept embedded active data',()=>{
  const nodes=flatten(descriptionNodes('![Desk](https://photos.example/desk.jpg) ![bad](data:image/svg+xml,x)'));
  const images=nodes.filter(node=>node.tag==='img');assert.equal(images.length,1);assert.ok(images[0].attributes.src.startsWith('https://imgproxy.iris.to/'));assert.equal(images[0].attributes.referrerpolicy,'no-referrer');
});
test('DOM rendering only uses text nodes and a fixed safe element vocabulary',()=>{
  const calls=[],doc={createTextNode:value=>({text:value}),createElement:tag=>{calls.push(tag);return{tag,children:[],attrs:{},setAttribute(key,value){this.attrs[key]=value},append(child){this.children.push(child)}}}};
  const root=renderDescription('A **desk** &amp; a [document](https://example.com/guide.pdf) <img onerror=x>',{document:doc});
  assert.equal(root.className,'detail-description markdown-description');assert.equal(calls.includes('img'),false);assert.equal(calls.includes('strong'),true);assert.equal(calls.includes('a'),true);
});
