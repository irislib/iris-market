import {execFile} from 'node:child_process';

const base='http://127.0.0.1:11434';
export interface LocalModelState {state:'off'|'connecting'|'missing'|'warming'|'ready'|'unavailable';model:string;checkedAt?:string}
/** Keep the installed Mac app available; never start a competing Ollama server. */
export function maintainLocalModel(model:string,{expectedDigest='',openApp=false}:{expectedDigest?:string;openApp?:boolean}={}) {
  let state:LocalModelState={state:model?'connecting':'off',model};
  let busy=false,closed=false,lastOpen=0,lastWarm=0;
  const controller=new AbortController();
  async function request(path:string,init:RequestInit={},timeout=5000) {
    return fetch(base+path,{...init,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(timeout)])});
  }
  async function check() {
    if(busy||closed||!model)return;busy=true;
    try {
      const response=await request('/api/tags');if(!response.ok)throw new Error('Ollama unavailable');
      const data=await response.json(),installed=data.models?.find(item=>item.name===model);
      if(!installed||expectedDigest&&installed.digest!==expectedDigest){state={state:'missing',model,checkedAt:new Date().toISOString()};return;}
      if(Date.now()-lastWarm>5*60*1000) {
        state={state:'warming',model};
        const warmed=await request('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:false,prompt:'',keep_alive:'10m',options:{num_ctx:2048}})},60000);
        if(!warmed.ok)throw new Error('Local model could not load');
        const result=await warmed.json();if(result.error)throw new Error('Local model could not load');
        lastWarm=Date.now();
      }
      state={state:'ready',model,checkedAt:new Date().toISOString()};
    }catch {
      if(closed)return;
      state={state:'unavailable',model,checkedAt:new Date().toISOString()};
      if(openApp&&process.platform==='darwin'&&Date.now()-lastOpen>120000){
        lastOpen=Date.now();execFile('/usr/bin/open',['-g','-a','/Applications/Ollama.app'],{timeout:10000},()=>{});
      }
    }finally{busy=false;}
  }
  const timer=setInterval(()=>void check(),30000);void check();
  return {state:()=>({...state}),close(){closed=true;clearInterval(timer);controller.abort();}};
}
