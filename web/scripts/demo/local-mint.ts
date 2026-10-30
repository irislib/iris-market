import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {isAbsolute} from 'node:path';

/** Genuine CDK FakeWallet fixture; its unbacked SQLite state lives only in this child. */
export async function startLocalTestMint({binary=process.env.MARKET_DEMO_MINT_BINARY,sha256=process.env.MARKET_DEMO_MINT_SHA256,port=0}:{binary?:string;sha256?:string;port?:number}={}) {
  if(!binary||!isAbsolute(binary)||!sha256||! /^[a-f0-9]{64}$/.test(sha256))throw new Error('Local demos require MARKET_DEMO_MINT_BINARY and its verified MARKET_DEMO_MINT_SHA256. See README local test mint setup.');
  if(createHash('sha256').update(await readFile(binary)).digest('hex')!==sha256)throw new Error('Local test mint binary digest differs from its configured pin.');
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid local mint port.');
  {const reservation=createServer();await new Promise<void>((resolve,reject)=>{reservation.once('error',reject);reservation.listen(port,'127.0.0.1',resolve);});port=(reservation.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));}
  const url=`http://127.0.0.1:${port}`;
  const child=spawn(binary,['--listen-host','127.0.0.1','--listen-port',String(port),'--base-url',url],{stdio:['ignore','pipe','ignore'],env:{...process.env,RUST_LOG:'info',TEST_MINT_FEE_PPK_SAT:'400'}});
  let ended=false,failed=false,listening=false,output='';
  child.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-8192);if(output.includes(`Standalone test mint listening on 127.0.0.1:${port}`))listening=true;});
  child.on('error',()=>{failed=true;});
  const exited=new Promise<void>(resolve=>child.once('close',()=>{ended=true;resolve();}));
  async function close(){if(ended)return;child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>;await Promise.race([exited,new Promise<void>(resolve=>{timer=setTimeout(resolve,5000);})]);clearTimeout(timer);if(!ended){child.kill('SIGKILL');await exited;}}
  try {
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      if(ended||failed)throw new Error('Local CDK test mint exited before readiness. Its port may already be owned.');
      try{if(!listening){await new Promise(resolve=>setTimeout(resolve,50));continue;}const response=await fetch(url+'/v1/info',{signal:AbortSignal.timeout(1000)});if(response.ok){const info=await response.json();if(info?.name==='Spilman Test Mint'&&info?.version==='cdk-spilman-test-mintd/0.17.0'&&info?.nuts&&!ended&&!failed)return {url,close};}}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('Local CDK test mint did not become ready.');
  }catch(error){await close();throw error;}
}
