import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';

test('OS lock excludes concurrent service writers and recovers after a forced exit',{timeout:10000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'market-lock-')),children=[];
  const start=()=>{const child=spawn('python3',['scripts/demo/service-runner.py',process.execPath,'--input-type=module','-e',"import {fstatSync} from 'node:fs';fstatSync(Number(process.env.MARKET_DEMO_LOCK_FD));console.log('ready');setInterval(()=>{},1000)"],{cwd:new URL('..',import.meta.url),env:{...process.env,MARKET_DEMO_STATE_DIR:directory},stdio:['ignore','pipe','pipe']});children.push(child);return child;};
  const ready=child=>new Promise((resolve,reject)=>{child.stdout.once('data',data=>String(data).includes('ready')?resolve():reject(Error('Unexpected service output')));child.once('error',reject);child.once('exit',code=>reject(Error(`Service exited: ${code}`)));});
  try {
    const first=start();await ready(first);
    const second=start();let message='';second.stderr.on('data',data=>message+=data);const [code]=await once(second,'exit');assert.notEqual(code,0);assert.match(message,/Another process owns/);
    const exited=once(first,'exit');first.kill('SIGKILL');await exited;
    const recovered=start();await ready(recovered);
  }finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;}await rm(directory,{recursive:true,force:true});}
});
