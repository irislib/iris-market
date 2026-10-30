import {build,transform} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,cp,stat,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';

if(process.platform!=='darwin')throw new Error('This installer manages a macOS launchd user service.');
const publicMode=process.argv.includes('--public');
const repo=resolve(import.meta.dirname,'../../..'),label=publicMode?'to.iris.market.demo.public':'to.iris.market.demo',uid=process.getuid!();
const service=`gui/${uid}/${label}`,root=join(homedir(),'Library','Application Support',publicMode?'Iris Market Public Demo':'Iris Market Demo');
const plist=join(homedir(),'Library','LaunchAgents',label+'.plist');
const command=process.argv.slice(2).find(value=>value!=='--public')??'status';
const ctl=(args:string[])=>execFileSync('/bin/launchctl',args,{encoding:'utf8'});
if(command==='status'){process.stdout.write(ctl(['print',service]));process.exit(0);}
if(command==='stop'){ctl(['bootout',service]);console.log('Demo stopped; its state and installation are preserved.');process.exit(0);}
if(command==='start'){ctl(['bootstrap',`gui/${uid}`,plist]);console.log('Demo started.');process.exit(0);}
if(command==='restart'){ctl(['kill','SIGTERM',service]);console.log('Restart requested; launchd will start the service again.');process.exit(0);}
if(command!=='install')throw new Error('Use install, status, start, stop or restart.');
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
if(execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim())throw new Error('Commit the accepted source before installing its service.');
const mintSource=publicMode?undefined:process.env.MARKET_DEMO_MINT_BINARY,mintSHA=publicMode?undefined:process.env.MARKET_DEMO_MINT_SHA256;
if(!publicMode&&(!mintSource||!mintSHA||! /^[a-f0-9]{64}$/.test(mintSHA)||createHash('sha256').update(await readFile(mintSource)).digest('hex')!==mintSHA))throw new Error('Configure and verify the local CDK mint binary and MARKET_DEMO_MINT_SHA256 before installing.');
const model=process.env.MARKET_DEMO_MODEL??'gemma3:1b';
const response=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(5000)});
const installed=(await response.json()).models?.find(item=>item.name===model);
if(!installed)throw new Error('Install and test the local Ollama model first.');
if(!publicMode)execFileSync('npm',['run','build','--prefix','web'],{cwd:repo,stdio:'inherit'});
const version=join(root,'versions',commit),assets=join(version,'web'),state=join(root,'state');
await mkdir(version,{recursive:true,mode:0o700});await mkdir(state,{recursive:true,mode:0o700});
await mkdir(join(root,'logs'),{recursive:true,mode:0o700});
const key=join(root,'vault-password');
try{await writeFile(key,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
if((await stat(key)).mode&0o077)throw new Error('The demo vault password file must be private.');
let active=false;try{ctl(['print',service]);active=true;}catch{}
await copyFile(join(import.meta.dirname,'service-runner.py'),join(version,'service-runner.py'));
const bundle=join(version,'server.mjs');
await build({entryPoints:[join(import.meta.dirname,publicMode?'public-server.ts':'server.ts')],bundle:true,platform:'node',format:'esm',target:'node22',outfile:bundle,external:['esbuild'],banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
if(!publicMode)await writeFile(join(version,'boot.js'),(await transform(await readFile(join(import.meta.dirname,'boot.ts'),'utf8'),{loader:'ts',target:'es2022'})).code,{mode:0o600});
if(!publicMode)await cp(join(repo,'web','dist'),assets,{recursive:true});
const escape=(value:unknown)=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
const mintBinary=join(version,'cdk-spilman-test-mintd');
if(!publicMode){await copyFile(mintSource!,mintBinary);await chmod(mintBinary,0o700);if(createHash('sha256').update(await readFile(mintBinary)).digest('hex')!==mintSHA)throw new Error('Installed local mint digest changed.');}
const values={...(publicMode?{}:{MARKET_DEMO_MINT_BINARY:mintBinary,MARKET_DEMO_MINT_SHA256:mintSHA!}),MARKET_DEMO_PORT:process.env.MARKET_DEMO_PORT??(publicMode?'4194':'4193'),MARKET_DEMO_RELAY_PORT:process.env.MARKET_DEMO_RELAY_PORT??'4789',MARKET_DEMO_MODEL:model,MARKET_DEMO_MODEL_DIGEST:installed.digest,MARKET_DEMO_ASSETS:assets,MARKET_DEMO_BOOT_FILE:join(version,'boot.js'),MARKET_DEMO_STATE_DIR:state,MARKET_DEMO_SECRET_FILE:key,MARKET_DEMO_MANAGE_OLLAMA:'1',PATH:'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'};
if(publicMode){delete values.MARKET_DEMO_RELAY_PORT;delete values.MARKET_DEMO_ASSETS;delete values.MARKET_DEMO_BOOT_FILE;}
const node=await stat('/opt/homebrew/bin/node').then(()=>'/opt/homebrew/bin/node',()=>process.execPath);
const xml=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>${escape(join(version,'service-runner.py'))}</string><string>${escape(node)}</string><string>${escape(bundle)}</string></array><key>WorkingDirectory</key><string>${escape(version)}</string><key>EnvironmentVariables</key><dict>${Object.entries(values).map(([k,v])=>`<key>${k}</key><string>${escape(v)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>20</integer><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${escape(join(root,'logs','service.log'))}</string><key>StandardErrorPath</key><string>${escape(join(root,'logs','error.log'))}</string></dict></plist>`;
await writeFile(join(version,'installed.json'),JSON.stringify({...(publicMode?{}:{mintSHA256:mintSHA}),commit,mode:publicMode?'public':'local',nodeVersion:process.version,model,digest:installed.digest,bundleSHA256:createHash('sha256').update(await readFile(bundle)).digest('hex'),installedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
// An explicit reinstall replaces only this named service, retaining old versions/state.
await mkdir(resolve(plist,'..'),{recursive:true});
const stagedPlist=join(version,'service.plist');await writeFile(stagedPlist,xml,{mode:0o600});
execFileSync('/usr/bin/plutil',['-lint',stagedPlist],{stdio:'pipe'});
if(active)ctl(['bootout',service]);
await copyFile(stagedPlist,plist);
execFileSync('/usr/bin/plutil',['-lint',plist],{stdio:'pipe'});
ctl(['bootstrap',`gui/${uid}`,plist]);
console.log(publicMode?`Public demo service installed; local health: http://127.0.0.1:${values.MARKET_DEMO_PORT}/_demo/status`:`Demo service installed: http://127.0.0.1:${values.MARKET_DEMO_PORT}/demo`);
