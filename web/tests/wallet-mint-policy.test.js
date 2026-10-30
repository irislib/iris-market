import test from 'node:test';import assert from 'node:assert/strict';
import {configuredLocalTestMint,DEFAULT_SUPPORTED_MINTS,isTestMint} from '../src/wallet/mints.ts';
test('local test mint is honored only from explicit document configuration on loopback site',()=>{
 const doc={documentElement:{dataset:{demoMint:'http://127.0.0.1:3338'}}};
 assert.equal(configuredLocalTestMint(doc,{hostname:'127.0.0.1'}),'http://127.0.0.1:3338');
 assert.equal(configuredLocalTestMint(doc,{hostname:'localhost'}),'http://127.0.0.1:3338');
 assert.equal(configuredLocalTestMint(doc,{hostname:'market.example'}),undefined);
 assert.equal(configuredLocalTestMint({documentElement:{dataset:{}}},{hostname:'localhost'}),undefined);
 doc.documentElement.dataset.demoMint='http://192.168.1.1:3338';assert.equal(configuredLocalTestMint(doc,{hostname:'localhost'}),undefined);
 assert.ok(DEFAULT_SUPPORTED_MINTS.every(value=>value.startsWith('https:')));assert.equal(isTestMint('http://127.0.0.1:3338'),true);
});
test('local HTTP token cards are parsed only under exact injected loopback policy',async()=>{
 const {cashuParts}=await import('../src/cashu-content.ts'),{getEncodedToken}=await import('@cashu/cashu-ts');
 const oldDoc=globalThis.document,oldLocation=globalThis.location;
 const value=getEncodedToken({mint:'http://127.0.0.1:3338',unit:'sat',proofs:[{amount:8,id:'009a1f293253e41e',secret:'fixture',C:'02'+'11'.repeat(32)}]});
 try{
  globalThis.document={documentElement:{dataset:{demoMint:'http://127.0.0.1:3338'}}};globalThis.location={hostname:'market.example'};assert.equal((await cashuParts(value))[0].type,'text');
  globalThis.location={hostname:'localhost'};assert.equal((await cashuParts(value))[0].type,'cashu');globalThis.document.documentElement.dataset.demoMint='http://127.0.0.1:3339';assert.equal((await cashuParts(value))[0].type,'text');
 }finally{globalThis.document=oldDoc;globalThis.location=oldLocation;}
});
