import test from 'node:test';
import assert from 'node:assert/strict';
import {finalizeEvent,generateSecretKey} from 'nostr-tools/pure';
import {listingDraft,revisedListingDraft} from '../src/composer.ts';
import {parseEvent} from '../src/market.ts';
import {serviceAreaCircle,serviceAreaContains} from '../src/service-area.ts';
const values={title:'Desk',description:'Local pickup',price:'100.50',currency:'eur',location:'Helsinki',side:'offer',category:'home'};
test('transport areas survive signing and edits without becoming location pins',()=>{
 const key=generateSecretKey(),pickup=serviceAreaCircle([24.94,60.17],10),destination=serviceAreaCircle([25.6,60.4],30);
 const draft=listingDraft({...values,category:'transport',serviceAreas:{pickup,destination}},{identifier:'transport-area'});
 const listing=parseEvent(finalizeEvent(draft,key));
 assert.deepEqual(listing.serviceAreas,{pickup,destination});assert.equal(listing.coordinates,null);
 assert(serviceAreaContains(listing.serviceAreas.pickup,[24.94,60.17]));assert(!serviceAreaContains(listing.serviceAreas.destination,[24.94,60.17]));
 const unchanged=parseEvent(finalizeEvent(revisedListingDraft({...values,title:'Revised'},listing),key));
 assert.deepEqual(unchanged.serviceAreas,listing.serviceAreas,'ordinary edits preserve exact boundaries');
 const cleared=parseEvent(finalizeEvent(revisedListingDraft({...values,serviceAreas:null},listing),key));
 assert.equal(cleared.serviceAreas,null);assert(!cleared.originalTags.some(t=>t[0]==='g'));
 const replaced=parseEvent(finalizeEvent(revisedListingDraft({...values,serviceAreas:{pickup:destination}},listing),key));
 assert.deepEqual(replaced.serviceAreas,{pickup:destination,destination});
 const unsupported={...listing,originalTags:[...listing.originalTags.filter(t=>t[0]!=='service_area'),['service_area','2','future','opaque']]};
 assert(revisedListingDraft(values,unsupported).tags.some(t=>t[0]==='service_area'&&t[1]==='2'),'unknown extensions remain unless explicitly edited');
});
test('web draft signs into the same NIP99 listing shape used by live browsing',()=>{const draft=listingDraft(values,{identifier:'test-listing'});const listing=parseEvent(finalizeEvent(draft,generateSecretKey()));assert.equal(listing.price,'100.50');assert.equal(listing.currency,'EUR');assert.equal(listing.location,'Helsinki');assert.equal(listing.identifier,'test-listing');});
test('web composer blocks unsafe image links and invalid values before asking a signer',()=>{for(const change of [{price:'-2'},{price:'Infinity'},{image:'http://example.com/a.png'},{image:'https://a:b@example.com/a.png'},{title:''},{side:'sell'},{currency:'<EUR>'}])assert.throws(()=>listingDraft({...values,...change}));});

import {nhashEncode} from '@hashtree/core';
import {createAttachmentSelection} from '../src/composer.ts';
const upload=(name='guide.pdf',isImage=false)=>{const hash=new Uint8Array(32).fill(isImage?2:1),sha256=Array.from(hash,x=>x.toString(16).padStart(2,'0')).join('');return{name,isImage,sha256,nhash:nhashEncode({hash}),size:42,mime:isImage?'image/png':'application/pdf',url:`https://cdn.iris.to/${sha256}.${isImage?'png':'pdf'}`};};
test('public attachments use interoperable Markdown, image tags only for photos and complete Hashtree metadata',()=>{
 const files=[upload('guide [desk].pdf'),upload('desk.png',true)],draft=listingDraft(values,{attachments:files});
 assert.match(draft.content,/\[guide \\\[desk\\\]\.pdf\]\(https:/);assert.match(draft.content,/!\[desk.png\]\(https:/);
 assert.equal(draft.tags.filter(tag=>tag[0]==='image').length,1);assert.equal(draft.tags.filter(tag=>tag[0]==='imeta').length,2);assert.equal(draft.tags.filter(tag=>tag[0]==='r').length,2);
 assert.ok(draft.tags.find(tag=>tag[0]==='r')[1].startsWith('htree://nhash1'));
 const listing=parseEvent(finalizeEvent(draft,generateSecretKey()));assert.equal(listing.imageUrl,files[1].url);assert.equal(listing.description,draft.content);
});
test('attachment values cannot inject Markdown, mismatched content addresses or active image formats',()=>{
 const file=upload('a](javascript:alert).pdf'),draft=listingDraft(values,{attachments:[file]});assert.ok(draft.content.includes('a\\](javascript:alert).pdf'));
 for(const change of [{url:'https://other.example/file.pdf'},{sha256:'b'.repeat(64)},{mime:'image/svg+xml',isImage:true},{name:'bad\nname'},{size:8*1024*1024+1}])assert.throws(()=>listingDraft(values,{attachments:[{...file,...change}]}));
 assert.throws(()=>listingDraft(values,{attachments:Array(5).fill(file)}),/four/);
});
test('file selection validates the whole addition and successful uploads are retained across retries',async()=>{
 const calls=[],first=new File(['one'],'one.pdf'),second=new File(['two'],'two.pdf');let fail=true;
 const selected=createAttachmentSelection(async file=>{calls.push(file.name);if(file===second&&fail)throw Error('offline');return upload(file.name)});
 selected.add([first,second]);assert.throws(()=>selected.add([first,second,first]),/four/);assert.equal(selected.items().length,2);
 await assert.rejects(selected.uploadAll(),/offline/);assert.equal(selected.items()[0].uploaded,true);assert.equal(selected.items()[1].uploaded,false);fail=false;
 assert.equal((await selected.uploadAll()).length,2);assert.deepEqual(calls,['one.pdf','two.pdf','two.pdf']);assert.equal(await first.text(),'one');selected.remove(0);assert.equal(selected.items()[0].file,second);selected.clear();assert.equal(selected.items().length,0);
});
test('cancelled file preparation never starts another upload',async()=>{
 let calls=0;const selected=createAttachmentSelection(async()=>{calls++;return upload()});selected.add([new File(['x'],'x.pdf')]);const control=new AbortController();control.abort();await assert.rejects(selected.uploadAll({signal:control.signal}),{name:'AbortError'});assert.equal(calls,0);
});

test('editing keeps the address, attachment metadata and location while replacing form fields',()=>{
 const secret=generateSecretKey(),original=listingDraft({...values,image:'https://example.com/desk.jpg'},{identifier:'stable-id',attachments:[upload()]});
 original.tags.push(['g','ud9wr'],['t','vintage'],['image','https://example.com/second.jpg']);
 const previous=parseEvent(finalizeEvent(original,secret));
 const revised=revisedListingDraft({...values,title:'Oak desk',price:'95',description:previous.description,image:previous.imageUrl},previous);
 const next=parseEvent(finalizeEvent(revised,secret));
 assert.equal(next.id,previous.id);assert.equal(next.title,'Oak desk');assert.equal(next.price,'95');assert(next.createdAt>previous.createdAt);
 assert.deepEqual(revised.tags.filter(t=>t[0]==='g'),[['g','ud9wr']]);assert(revised.tags.some(t=>t[0]==='imeta'));assert(revised.tags.some(t=>t[0]==='r'));assert(revised.tags.some(t=>t[0]==='t'&&t[1]==='vintage'));assert.equal(revised.tags.filter(t=>t[0]==='image').length,2);
 assert.equal(revised.content,previous.description);assert(Object.isFrozen(previous.originalTags));assert(Object.isFrozen(previous.originalTags[0]));
});

 test('courier drafts carry explicit searchable tags and edits can remove them',()=>{
 const draft=listingDraft({...values,category:'transport',tags:['courier','parcel','transport',' #Parcel ']});
 assert.deepEqual(draft.tags.filter(tag=>tag[0]==='t').map(tag=>tag[1]),['transport','courier','parcel']);
 const previous=parseEvent(finalizeEvent(draft,generateSecretKey()));
 const edited=revisedListingDraft({...values,category:'transport',tags:'passenger, ride'},previous);
 assert.deepEqual(edited.tags.filter(tag=>tag[0]==='t').map(tag=>tag[1]),['transport','passenger','ride']);
 for(const tags of [Array.from({length:9},(_,i)=>String(i)),['x'.repeat(61)],['bad\nlabel'],[{}]])assert.throws(()=>listingDraft({...values,tags}));
 });

test('Buying is relay-indexed without exposing its marker as a category',()=>{
 const draft=listingDraft({...values,side:'request'},{identifier:'buying'}),key=generateSecretKey();
 assert(draft.tags.some(tag=>tag[0]==='t'&&tag[1]==='market:request'));
 const indexed={...draft,tags:draft.tags.filter(tag=>tag[0]!=='market')};
 const parsed=parseEvent(finalizeEvent(indexed,key));assert.equal(parsed.side,'request');assert.equal(parsed.category,'home');assert(!parsed.tags.includes('market:request'));
 const explicit=parseEvent(finalizeEvent({...indexed,tags:[...indexed.tags,['market','offer']]},key));assert.equal(explicit.side,'offer');
});
