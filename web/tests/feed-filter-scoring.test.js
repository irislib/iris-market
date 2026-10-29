import test from 'node:test';
import assert from 'node:assert/strict';
import {debertaEntailmentScore} from '../src/feed-filter/scoring.ts';

test('neutral-dominant output is a nonmatch even if entailment exceeds contradiction',()=>{
  const logits=new Float32Array([-2,-1,8]);
  const oldBinaryScore=1/(1+Math.exp(logits[0]-logits[1]));
  assert(oldBinaryScore>.7);
  const score=debertaEntailmentScore(logits);
  assert(Math.abs(score-Math.exp(-1)/(Math.exp(-2)+Math.exp(-1)+Math.exp(8)))<1e-12);
  assert(score<.001);
  assert.equal(debertaEntailmentScore([0,0,0]),1/3);
});

test('entailment and contradiction retain their pinned label positions',()=>{
  assert(debertaEntailmentScore([1,8,0])>.99);
  assert(debertaEntailmentScore([8,1,0])<.01);
  assert(debertaEntailmentScore([0,1,8])<.01);
});

test('full three-way normalization remains finite and invariant under large logit shifts',()=>{
  const expected=debertaEntailmentScore([0,1,2]);
  assert(Math.abs(expected-debertaEntailmentScore([1000,1001,1002]))<1e-12);
  assert(Math.abs(expected-debertaEntailmentScore([-1000,-999,-998]))<1e-12);
  assert.equal(debertaEntailmentScore([-1000,1000,-1000]),1);
});

test('wrong output shape and non-finite logits fail rather than becoming match decisions',()=>{
  for(const value of [[],[1,2],[1,2,3,4],[NaN,1,2],[1,Infinity,2],[1,2,-Infinity]])assert.throws(()=>debertaEntailmentScore(value),/invalid relevance/);
});
