#!/usr/bin/env node
// Established release destinations only. Candidate builds are sealed separately.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HTREE_SHA256, publicReadEnvironment } from './publish-hashtree.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const repo = 'irislib/iris-market';
const tree = 'releases/iris-market';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const require = (condition, message) => { if (!condition) throw Error(message); };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const run = (program, args, options = {}) => execFileSync(program, args, {cwd:root, encoding:'utf8', maxBuffer:8*1024*1024, stdio:['ignore','pipe','pipe'], ...options});
const gh = (endpoint, extra = []) => JSON.parse(run('gh', ['api', `repos/${repo}/${endpoint}`, ...extra]));
const sameFiles = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && new Set(a.map(file=>file.name)).size === a.length && new Set(b.map(file=>file.name)).size === b.length && a.every(file => b.some(other => other.name === file.name && other.sha256 === file.sha256 && other.bytes === file.bytes));

export function validateGitHubRelease(release, expected, draft) {
  require(release && release.tag_name === expected.tag && release.target_commitish === expected.sourceCommit && release.prerelease === true && release.draft === draft, 'GitHub release identity or state differs');
  require(release.assets.length === expected.files.length && expected.files.every(file => release.assets.some(asset => asset.name === file.name && asset.state === 'uploaded' && asset.size === file.bytes && asset.digest === `sha256:${file.sha256}`)), 'GitHub assets differ from the accepted inventory');
  return release;
}
export function validatePublicProof(proof, expected) {
  require(proof.passed === true && proof.tag === expected.tag && proof.sourceCommit === expected.sourceCommit && sameFiles(proof.files, expected.files), 'Public download proof differs from accepted files');
}
export function publicationRecord(expected, epoch) {
  return {id:expected.tag, title:`Iris Market ${expected.tag}`, tag:expected.tag, commit:expected.sourceCommit, created_at:epoch, published_at:epoch, draft:false, prerelease:true, notes_file:'notes.md', assets:expected.files.map(file => ({name:file.name,path:`assets/${file.name}`,size:file.bytes,sha256:file.sha256}))};
}
async function save(file, value, privateFile = false) {
  const content = JSON.stringify(value,null,2)+'\n';
  try { await writeFile(file,content,{flag:'wx',mode:privateFile?0o600:0o644}); }
  catch(error) { if(error.code !== 'EEXIST' || await readFile(file,'utf8') !== content) throw Error('Refusing to replace existing release evidence'); }
}
async function checked(options) {
  for(const key of ['assets','acceptance','tag','commit']) require(options[key],`Missing --${key}`);
  require(/^v\d+\.\d+\.\d+-alpha\.[1-9]\d*$/.test(options.tag) && /^[a-f0-9]{40}$/.test(options.commit),'Use an exact release tag and full commit');
  options.assets = path.resolve(options.assets);
  const result = JSON.parse(run('python3',['scripts/alpha-release.py','publication-check','--tag',options.tag,'--commit',options.commit,'--assets',options.assets,'--acceptance',path.resolve(options.acceptance)]));
  return result;
}
function verifyRemoteTag(expected) {
  let value = gh(`git/ref/tags/${expected.tag}`).object;
  for(let n=0; value.type==='tag' && n<3; n++) value = gh(`git/tags/${value.sha}`).object;
  require(value.type==='commit' && value.sha===expected.sourceCommit,'Public source tag differs from accepted commit');
}
async function publicJSON(url) {
  const response = await fetch(url,{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
  require(response.ok,'Public metadata is unavailable');
  const text=await response.text();require(text.length<4*1024*1024,'Public metadata exceeds its bound');return JSON.parse(text);
}
async function downloadProof(url, file) {
  const response = await fetch(url,{signal:AbortSignal.timeout(180000)});
  require(response.ok && response.body,'Public artifact is unavailable');
  const hash=createHash('sha256');let bytes=0;
  for await(const chunk of response.body) {bytes+=chunk.length;require(bytes<=file.bytes,'Public artifact exceeds accepted size');hash.update(chunk);}
  require(bytes===file.bytes && hash.digest('hex')===file.sha256,'Public artifact differs from accepted bytes');
  return {...file,url,passed:true};
}
export function lookupGitHubRelease(tag, get = value => gh(`releases/tags/${value}`), list = () => JSON.parse(run('gh', ['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--slurp'])).flat()) {
  try { return get(tag); }
  catch (error) {
    if (!/\(HTTP 404\)/.test(String(error.stderr ?? ''))) throw error;
    // GitHub's tag endpoint can omit drafts. Check the authenticated inventory
    // before creating anything, including releases beyond its first page.
    const matches = list().filter(release => release.tag_name === tag);
    require(matches.length <= 1, 'Multiple releases use this tag; preserve and inspect them');
    return matches[0];
  }
}
async function github(operation, options, expected) {
  if(operation==='github-verify') {
    const release=validateGitHubRelease(await publicJSON(`https://api.github.com/repos/${repo}/releases/tags/${expected.tag}`),expected,false);
    const files=[];
    for(const file of expected.files) {
      const asset=release.assets.find(asset=>asset.name===file.name);
      const prefix=`https://github.com/${repo}/releases/download/${expected.tag}/`;
      require(asset.browser_download_url.startsWith(prefix),'Unexpected artifact download destination');
      files.push(await downloadProof(asset.browser_download_url,file));
    }
    await save(path.join(options.assets,'github-public-download-verification.json'),{...expected,passed:true,anonymous:true,authorizationHeadersUsed:false,releaseURL:release.html_url,files});
    return;
  }
  verifyRemoteTag(expected);
  if(operation==='github-draft') {
    require(options.notes,'Draft creation requires --notes');
    const stat=await lstat(options.notes);require(stat.isFile() && !stat.isSymbolicLink() && stat.size<=1024*1024,'Release notes must be a regular bounded file');
    let release=lookupGitHubRelease(expected.tag);
    if (!release) {
      run('gh',['release','create',expected.tag,'--repo',repo,'--verify-tag','--target',expected.sourceCommit,'--draft','--prerelease','--title',`Iris Market ${expected.tag}`,'--notes-file',path.resolve(options.notes)]);
      release=lookupGitHubRelease(expected.tag);
    }
    require(release && release.draft && release.prerelease && release.target_commitish===expected.sourceCommit,'Existing release is not this draft; no assets replaced');
    require(release.assets.every(asset=>expected.files.some(file=>file.name===asset.name && file.bytes===asset.size && asset.digest===`sha256:${file.sha256}`)),'Existing draft assets differ; no assets replaced');
    const missing=expected.files.filter(file=>!release.assets.some(asset=>asset.name===file.name));
    if(missing.length)run('gh',['release','upload',expected.tag,'--repo',repo,...missing.map(file=>path.join(options.assets,file.name))]);
    release=validateGitHubRelease(lookupGitHubRelease(expected.tag),expected,true);
    await save(path.join(options.assets,'github-draft-verification.json'),{...expected,passed:true,releaseId:release.id});
    return;
  }
  const release=validateGitHubRelease(lookupGitHubRelease(expected.tag),expected,true);
  const published=validateGitHubRelease(gh(`releases/${release.id}`,['--method','PATCH','-F','draft=false','-F','prerelease=true']),expected,false);
  await save(path.join(options.assets,'github-publication.json'),{...expected,published:true,releaseURL:published.html_url,publishedAt:published.published_at});
}
async function helper() {
  const binary=process.env.HTREE_BIN;
  require(binary && path.isAbsolute(binary),'Set HTREE_BIN to the existing pinned helper');
  require(sha256(await readFile(binary))===HTREE_SHA256,'Hashtree helper differs from pinned release tool');return binary;
}
function htree(binary,args,env) {
  const result=spawnSync(binary,args,{cwd:root,env,encoding:'utf8',maxBuffer:8*1024*1024,timeout:600000});
  require(!result.error && result.status===0,'Hashtree command failed; publication state must be checked before retry');
  const output=result.stdout+'\n'+result.stderr;
  require(!/file server push failed|Errors:\s*[1-9]/i.test(output),'Hashtree reported partial upload');return output;
}
export function recordFrom(output) {
  const start=output.indexOf('{');require(start>=0,'Release record unavailable');
  let depth=0, quoted=false, escaped=false;
  for(let index=start; index<output.length; index++) {
    const char=output[index];
    if(quoted) { if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false; }
    else if(char==='"')quoted=true;
    else if(char==='{')depth++;
    else if(char==='}' && --depth===0)return JSON.parse(output.slice(start,index+1));
  }
  throw Error('Incomplete release record');
}
export function previousRelease(proof) {
  require(proof.passed===true && proof.releaseTree===tree && /^nhash1[ac-hj-np-z02-9]+$/i.test(proof.versionNhash??''),'Missing previously accepted Hashtree release proof');
  const url=new URL(proof.releaseRecordURL);
  const owner=url.pathname.split('/')[1];
  require(url.protocol==='https:' && url.hostname==='upload.iris.to' && /^npub1[ac-hj-np-z02-9]+$/i.test(owner),'Previous release proof has an unexpected owner or destination');
  require(/^v\d+\.\d+\.\d+-alpha\.[1-9]\d*$/.test(proof.tag??'') && /^[a-f0-9]{40}$/.test(proof.sourceCommit??''),'Previous release identity is invalid');
  return {owner,tag:proof.tag,commit:proof.sourceCommit,versionNhash:proof.versionNhash};
}
async function hashtree(operation,options,expected) {
  const binary=await helper();
  const work=path.join(options.assets,'hashtree');await mkdir(work,{recursive:true});
  if(operation==='hashtree-publish') {
    require(options.notes && options.previous,'Use --notes and --previous with accepted prior Hashtree proof');
    validatePublicProof(await json(path.join(options.assets,'github-public-download-verification.json')),expected);
    const prior=previousRelease(await json(options.previous));
    require(prior.tag!==expected.tag,'New release must not replace the previous version');
    const env={...process.env,NOSTR_PREFER_LOCAL:'0',HTREE_PREFER_LOCAL_DAEMON:'0',HTREE_PREFER_LOCAL_RELAY:'0',HTREE_DATA_DIR:path.join(work,'publisher-data')};
    for(const name of ['NOSTR_SECRET_KEY','HTREE_LOCAL_DAEMON_ONLY','HTREE_GIT_REBUILD_FROM_LOCAL'])delete env[name];
    require(htree(binary,['user'],env).includes(prior.owner),'Current publisher is not the established release owner');
    const priorRecord=recordFrom(htree(binary,['cat',`${prior.versionNhash}/release.json`],env));
    require(priorRecord.tag===prior.tag && priorRecord.commit===prior.commit,'Previous immutable release differs from its proof');
    const stage=path.join(work,'stage');await mkdir(stage);await mkdir(path.join(stage,'assets'));
    for(const file of expected.files)await copyFile(path.join(options.assets,file.name),path.join(stage,'assets',file.name));
    const notes=await readFile(options.notes);require(notes.length<=1024*1024,'Release notes exceed their bound');await writeFile(path.join(stage,'notes.md'),notes,{flag:'wx'});
    const epoch=Math.floor(Date.now()/1000);
    await save(path.join(stage,'release.json'),publicationRecord(expected,epoch));
    const added=htree(binary,['add',stage],env);const hashes=added.match(/nhash1[ac-hj-np-z02-9]+/gi);
    require(hashes?.length,'No immutable release hash returned');const versionNhash=hashes.at(-1);
    await checked(options); // Recheck sealed artifacts immediately before public mutation.
    const output=htree(binary,['release','publish',tree,expected.tag,versionNhash],env);
    require(output.includes('Loading existing release path'),'Existing release inventory was not loaded; inspect before proceeding');
    await save(path.join(work,'publication.json'),{...expected,published:true,versionNhash,releaseTree:tree,owner:prior.owner,previous:prior});
    return;
  }
  const publication=await json(path.join(work,'publication.json'));
  require(publication.published && publication.tag===expected.tag && publication.sourceCommit===expected.sourceCommit && sameFiles(publication.files,expected.files),'Hashtree publication differs from accepted release');
  const temporary=await mkdtemp(path.join(tmpdir(),'iris-alpha-read-'));
  try {
    const env=publicReadEnvironment(process.env,temporary);await mkdir(env.HTREE_CONFIG_DIR);await writeFile(path.join(env.HTREE_CONFIG_DIR,'config.toml'),'[updater]\nauto_check = false\nauto_install = false\n');
    const directory=path.join(temporary,'version');htree(binary,['get',publication.versionNhash,'-o',directory],env);
    for(const file of expected.files){const filePath=path.join(directory,'assets',file.name);const stat=await lstat(filePath);require(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===file.bytes&&sha256(await readFile(filePath))===file.sha256,'Immutable Hashtree artifact differs');}
    const base=`https://upload.iris.to/${publication.owner}/releases%2Firis-market`;
    for(const tag of [expected.tag,'latest',publication.previous.tag]) {
      const record=await publicJSON(`${base}/${tag}/release.json`);
      require(record.tag===(tag===publication.previous.tag?publication.previous.tag:expected.tag) && record.commit===(tag===publication.previous.tag?publication.previous.commit:expected.sourceCommit),'Mutable Hashtree release or preserved previous release differs');
    }
    const files=[];for(const file of expected.files)files.push(await downloadProof(`${base}/${expected.tag}/assets/${file.name}`,file));
    await save(path.join(work,'acceptance.json'),{...expected,passed:true,versionNhash:publication.versionNhash,releaseTree:tree,releaseRecordURL:`${base}/${expected.tag}/release.json`,anonymousFreshConfigAndCache:true,authorizationHeadersUsed:false,previousReleasePreserved:true,files});
  } finally {await rm(temporary,{recursive:true,force:true});}
}
export async function main(argv=process.argv.slice(2)) {
  const [operation,...flags]=argv;
  if(!operation||operation==='--help'){console.log('publish-alpha.mjs github-draft|github-publish|github-verify|hashtree-publish|hashtree-verify --assets DIR --acceptance JSON --tag TAG --commit FULL_COMMIT [--notes FILE] [--previous PRIOR_HASHTREE_PROOF]\nDraft uploads never replace assets. Publish only after source, runtime and sealed-artifact acceptance.');return;}
  require(['github-draft','github-publish','github-verify','hashtree-publish','hashtree-verify'].includes(operation),'Unknown publication operation');
  const options={};for(let i=0;i<flags.length;i+=2){require(['--assets','--acceptance','--tag','--commit','--notes','--previous'].includes(flags[i])&&flags[i+1]&&!options[flags[i].slice(2)],'Invalid or duplicate publication option');options[flags[i].slice(2)]=flags[i+1];}
  const expected=await checked(options);
  if(operation.startsWith('github-'))await github(operation,options,expected);else await hashtree(operation,options,expected);
  console.log(JSON.stringify({operation,tag:expected.tag,sourceCommit:expected.sourceCommit,files:expected.files.length,passed:true}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){main().catch(error=>{console.error(`Alpha publication failed: ${error.status==null?error.message:'external verification failed'}`);process.exitCode=1;});}
