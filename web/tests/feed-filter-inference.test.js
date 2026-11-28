import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'

// Substitute only the two model/runtime imports. Run the production prompt,
// token budgeting, answer validation and tensor cleanup without a model download.
export const env = {backends:{onnx:{wasm:{}}}}
export const RUNTIME = {mjs:'runtime.mjs'}, CPU_RUNTIME = RUNTIME
export const loadRuntimeBinary = async () => new Uint8Array()
let prompt, answer, released
const tokenizer = () => ({input_ids:{dims:[1,1]}, dispose(){ released.push('inputs') }})
tokenizer.encode = text => {
  const word = text.trim().toLowerCase()
  if (word === 'yes' || word === 'no') return [word === 'yes' ? 1 : 2]
  return [...new TextEncoder().encode(text)]
}
tokenizer.decode = ids => ids.length === 1 ? answer : 'shortened listing'
tokenizer.apply_chat_template = messages => (prompt=messages[1].content)
export const AutoTokenizer = {from_pretrained:async()=>tokenizer}
// Token 0 ("unclear") has the largest logit. Restricting the denominator
// to yes/no alone would report a strong negative for that answer.
const fakeModel = async () => ({
  logits:{dims:[1,1,3],data:answer==='unclear' ? [12,-6,-1] : answer==='no' ? [-6,-1,12] : [-6,12,-1]},
  dispose(){ released.push('output') }
})
fakeModel.dispose = async () => {}
fakeModel.generate = async () => ({tolist:()=>[[0,1]], dispose(){ released.push('output') }})
export const AutoModelForCausalLM = {from_pretrained:async()=>fakeModel}
export const AutoModelForSequenceClassification = AutoModelForCausalLM

test('Qwen budgets actual tokens and requires an explicit yes or no before caching a decision',async t=>{
  const hook=registerHooks({resolve(name,context,next){
    if(context.parentURL?.endsWith('/feed-filter/inference.ts') &&
       (name==='@huggingface/transformers'||name==='./runtime.ts')) return {url:import.meta.url,shortCircuit:true}
    return next(name,context)
  }})
  t.after(()=>hook.deregister())
  const gpu=Object.getOwnPropertyDescriptor(navigator,'gpu')
  Object.defineProperty(navigator,'gpu',{configurable:true,value:{requestAdapter:async()=>({})}})
  t.after(()=>gpu ? Object.defineProperty(navigator,'gpu',gpu) : delete navigator.gpu)
  const {loadModel,classifyListing,disposeModel}=await import('../src/feed-filter/inference.ts')
  t.after(disposeModel)
  await loadModel('qwen35','webgpu')
  await t.test('unrelated output cannot silently hide a listing',async()=>{
    released=[];answer='unclear'
    await assert.rejects(classifyListing('chair','pine chair'),/yes or no/)
    assert.deepEqual(released,['output','inputs'])
  })
  await t.test('multibyte listings are shortened by token count',async()=>{
    for (const [text,score] of [['Yes!',1],['no',0]]) {
      released=[];answer=text
      const result=await classifyListing('chair','椅'.repeat(500))
      assert.equal(result.truncated,true)
      assert.match(prompt,/shortened listing/)
      assert.equal(result.score,score)
      assert.deepEqual(released,['output','inputs'])
    }
  })
})
