import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_HOME_FEED_PROMPT,HOME_FEED_STORAGE_KEY,homeFeedConditions,homeProductText,loadHomeFeed,saveHomeFeed} from '../src/home-feed.ts';
import {validateInput} from '../src/feed-filter/models.ts';

test('the small model checks useful intent and exclusions separately; long custom prompts fit each request',()=>{
  const rules=homeFeedConditions(DEFAULT_HOME_FEED_PROMPT,'deberta');
  assert.equal(rules.length,4);assert(!rules[2].productConfirmation);assert(rules[3].productConfirmation);assert.equal(rules[2].condition,rules[3].condition);assert.match(rules[0].condition,/useful/);assert.equal(rules[1].exclude,true);assert.equal(rules[2].exclude,true);assert.match(rules[2].condition,/steroids/);
  for(const model of ['browser','deberta']){
    const conditions=homeFeedConditions('creative things '.repeat(60)+'musical instruments',model);
    assert(conditions.length>1);
    for(const {condition} of conditions)validateInput(condition,'Example item');
    assert.match(conditions.at(-1).condition,/musical instruments/);
  }
});

test('home preferences persist separately and preserve an explicit Off',()=>{
  const data=new Map(),storage={getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};
  assert.deepEqual(loadHomeFeed(storage),{enabled:true,prompt:DEFAULT_HOME_FEED_PROMPT});
  saveHomeFeed(storage,{enabled:false,prompt:'  Handmade things  '});
  assert.deepEqual(loadHomeFeed(storage),{enabled:false,prompt:'Handmade things'});
  assert.deepEqual([...data.keys()],[HOME_FEED_STORAGE_KEY]);
  saveHomeFeed(storage,{enabled:true,prompt:'x'.repeat(1200)});assert.equal(loadHomeFeed(storage).prompt.length,1000);
  data.set(HOME_FEED_STORAGE_KEY,'invalid');assert.equal(loadHomeFeed(storage).prompt,DEFAULT_HOME_FEED_PROMPT);
});

test('the default specialist-product check includes seller tags even after a long description',()=>{
  assert.equal(homeProductText({title:'Enantato de Testosterona',tags:['hormônios','anabolizante'],description:'Copy '.repeat(1000)}),'Enantato de Testosterona\nhormônios, anabolizante');
  assert.equal(homeProductText({title:'Bicycle',category:'Transport'}),'Bicycle\nTransport');
  assert.equal(homeProductText({title:'Bicycle',tags:[],category:'Other'}),'Bicycle');
  assert(!homeFeedConditions('Creative things','deberta').some(rule=>rule.productConfirmation));
});
