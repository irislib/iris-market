import test from 'node:test';
import assert from 'node:assert/strict';
import {marketplaceToolEnabled,saveMarketplaceTool} from '../src/marketplace-flags.ts';

test('escrow is opt-in and scoped to the active profile',()=>{
  const rows=new Map(),old=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:k=>rows.get(k)??null,setItem:(k,v)=>rows.set(k,v)}});
  try{
    for(const owner of ['a','b',''])assert.equal(marketplaceToolEnabled('escrow',owner),false);
    saveMarketplaceTool('escrow',true,'a');assert.equal(marketplaceToolEnabled('escrow','a'),true);
    assert.equal(marketplaceToolEnabled('escrow','b'),false);
    saveMarketplaceTool('escrow',false,'a');
    assert.equal(marketplaceToolEnabled('escrow','a'),false);
  }finally{if(old)Object.defineProperty(globalThis,'localStorage',old);else delete globalThis.localStorage;}
});
