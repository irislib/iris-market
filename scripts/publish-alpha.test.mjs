import test from 'node:test';
import assert from 'node:assert/strict';
import {previousRelease, publicationRecord, recordFrom, validateGitHubRelease, validatePublicProof} from './publish-alpha.mjs';

const expected={tag:'v0.1.3-alpha.1',sourceCommit:'a'.repeat(40),files:Array.from({length:11},(_,index)=>({name:`asset-${index}`,bytes:index+1,sha256:String(index%10).repeat(64)}))};
const github=()=>({tag_name:expected.tag,target_commitish:expected.sourceCommit,draft:true,prerelease:true,assets:expected.files.map(file=>({name:file.name,size:file.bytes,digest:`sha256:${file.sha256}`,state:'uploaded'}))});

test('full manifest-derived inventory replaces fixed nine-file assumptions',()=>{
  validateGitHubRelease(github(),expected,true);
  for(const mutate of [value=>value.assets.pop(),value=>value.assets.push(value.assets[0]),value=>value.assets[0].digest='sha256:bad',value=>value.target_commitish='b'.repeat(40),value=>value.draft=false]){
    const release=github();mutate(release);assert.throws(()=>validateGitHubRelease(release,expected,true));
  }
  const legacy={...expected,files:expected.files.slice(0,9)};
  const release=github();release.assets=release.assets.slice(0,9);validateGitHubRelease(release,legacy,true);
});

test('public proof binds all names, hashes, source and byte counts',()=>{
  const proof={...expected,passed:true};validatePublicProof(proof,expected);
  assert.throws(()=>validatePublicProof({...proof,files:proof.files.slice(1)},expected));
  assert.throws(()=>validatePublicProof({...proof,files:proof.files.map(()=>proof.files[0])},expected));
  assert.throws(()=>validatePublicProof({...proof,passed:false},expected));
  assert.throws(()=>validatePublicProof({...proof,sourceCommit:'b'.repeat(40)},expected));
});

test('release record includes every accepted file without local paths',()=>{
  const record=publicationRecord(expected,1234);
  assert.equal(record.assets.length,11);assert.equal(record.commit,expected.sourceCommit);
  assert.equal(record.assets[10].path,'assets/asset-10');assert.equal(record.published_at,1234);
  assert.equal(recordFrom(`Reading release\n${JSON.stringify(record)}\nFinished`).tag,expected.tag);
  assert.deepEqual(recordFrom('x {"note":"a } and \\"{\\"","nested":{"ok":true}} trailing'),{note:'a } and "{"',nested:{ok:true}});
  assert.throws(()=>recordFrom('no JSON'));assert.throws(()=>recordFrom('{"incomplete":'));
});

test('previous release proof constrains publisher and established tree',()=>{
  const proof={passed:true,tag:'v0.1.1-alpha.1',sourceCommit:'b'.repeat(40),releaseTree:'releases/iris-market',versionNhash:'nhash1qqqqqq',releaseRecordURL:'https://upload.iris.to/npub1qqqqqq/releases%2Firis-market/v0.1.1-alpha.1/release.json'};
  assert.equal(previousRelease(proof).owner,'npub1qqqqqq');
  for(const mutation of [{releaseTree:'another-tree'},{versionNhash:'https://other.invalid'},{releaseRecordURL:'https://other.invalid/npub1qqqqqq/file'},{passed:false}])assert.throws(()=>previousRelease({...proof,...mutation}));
});
