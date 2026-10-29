import test from 'node:test';
import assert from 'node:assert/strict';
import {SocialGraph} from 'nostr-social-graph';
import {projectSocialGraph} from '../scripts/project-social-graph.ts';
const key=n=>n.toString(16).padStart(64,'0');
async function aliases(follows,mutes=[]){
 const bytes=[],integer=value=>{while(value>=128){bytes.push((value&127)|128);value>>>=7;}bytes.push(value);};
 integer(2);const keys=[1,2,2,3,4,5,6];integer(keys.length);keys.forEach((n,id)=>{bytes.push(...Buffer.from(key(n),'hex'));integer(id);});
 for(const lists of [follows,mutes]){integer(lists.length);for(const [owner,time,targets]of lists){integer(owner);integer(time);integer(targets.length);targets.forEach(integer);}}
 return SocialGraph.fromBinary(key(1),new Uint8Array(bytes));
}
test('canonical projection resolves aliases before traversal and retains all tied latest mutes',async()=>{
 const source=await aliases([[0,1,[1]],[2,2,[3]],[3,3,[6]]],[[1,5,[4]],[2,5,[5]],[3,10,[]]]);
 const projected=await projectSocialGraph(source,key(1),1),graph=await SocialGraph.fromBinary(key(1),await projected.toBinary());
 assert.deepEqual(graph.getFollowedByUser(key(2)),new Set([key(3)]));assert.equal(graph.getFollowDistance(key(3)),2);assert.equal(graph.getFollowDistance(key(6)),1000);
 assert.deepEqual(graph.getMutedByUser(key(2)),new Set([key(4),key(5)]));assert.equal(graph.getMuteListCreatedAt(key(2)),5);
 const identities=[...graph.getInternalData().ids].map(([,pubkey])=>pubkey);assert.equal(new Set(identities).size,identities.length);
 const wider=await projectSocialGraph(source,key(1),2);assert.equal((await SocialGraph.fromBinary(key(1),await wider.toBinary())).getMuteListCreatedAt(key(3)),10);
});
test('newer explicit empty lists override older duplicate identities',async()=>{
 const graph=await projectSocialGraph(await aliases([[0,1,[1]],[1,1,[4]],[2,2,[3]]],[[1,5,[4]],[2,6,[]]]),key(1),1);
 assert.deepEqual(graph.getFollowedByUser(key(2)),new Set([key(3)]));assert.deepEqual(graph.getMutedByUser(key(2)),new Set());assert.equal(graph.getMuteListCreatedAt(key(2)),6);
});
test('tied conflicting latest follow lists cannot broaden the graph',async()=>{
 await assert.rejects(projectSocialGraph(await aliases([[0,1,[1]],[1,2,[3]],[2,2,[4]]]),key(1),1),/conflicting latest follow lists/);
});
