import {mkdir,open,rename,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import type {VaultBackend,VaultRow} from '../../src/messaging/vault.ts';

/** One service owns this directory. Files contain encrypted vaults or signed ciphertext. */
export async function stateFile(directory:string,name:string,maxBytes=12*1024*1024) {
  await mkdir(directory,{recursive:true,mode:0o700});
  if(((await stat(directory)).mode&0o077)!==0)throw new Error('Demo state directory must be private.');
  const path=join(directory,name);let queue=Promise.resolve();
  return {
    async read(){try{if((await stat(path)).size>maxBytes)throw new Error('Demo state exceeds limit.');return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return undefined;throw error;}},
    write(value:unknown){const operation=queue.then(async()=>{const text=JSON.stringify(value);if(Buffer.byteLength(text)>maxBytes)throw new Error('Demo state exceeds limit.');const temporary=path+'.tmp';const file=await open(temporary,'w',0o600);try{await file.writeFile(text);await file.sync();}finally{await file.close();}await rename(temporary,path);const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}});queue=operation.catch(()=>{});return operation;},
    flush:()=>queue,
  };
}
export async function persistentVaultBackend(directory:string,name:string):Promise<VaultBackend> {
  const file=await stateFile(directory,name);let version=(await file.read())?.version??0;
  return {
    async read(){const row=await file.read();if(!row)return undefined;if(row.mode!=='password'||row.key)throw new Error('Demo state requires an encrypted password vault.');return {...row,salt:new Uint8Array(Buffer.from(row.salt,'base64')),iv:new Uint8Array(Buffer.from(row.iv,'base64')),ciphertext:Uint8Array.from(Buffer.from(row.ciphertext,'base64')).buffer} as VaultRow;},
    async write(row,expectedVersion){if(expectedVersion!==version)throw new Error('Demo state changed.');if(row.mode!=='password'||row.key)throw new Error('Demo state requires an encrypted password vault.');await file.write({...row,salt:Buffer.from(row.salt!).toString('base64'),iv:Buffer.from(row.iv!).toString('base64'),ciphertext:Buffer.from(row.ciphertext!).toString('base64')});version=row.version??0;},
  };
}
