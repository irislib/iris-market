import { npubEncode } from 'nostr-tools/nip19';
import { parseMarketRoute, listingURL, profileURL, pageURL } from './routes.ts';
import { dismissOnBackdrop } from './surface.ts';
import { renderListingPage } from './listing-page.ts';
import { setupProductReviews } from './product-reviews-ui.ts';
import {setupServiceAreaPicker} from './service-area-ui.ts';
import { byId, element as domElement, formFields } from './dom.ts';
import { MarketRelayClient, DEFAULT_RELAYS, validateRelays, applyEvent, type MarketListing } from './market.ts';
import previewListings from './preview.json';
import { setupTheme } from './theme.ts';
import { setupHeaderMenu } from './menu.ts';
import { COUNTRY_CODES, createShippingResolver, matchesShippingDestination } from './shipping.ts';
import { createSocialRootController } from './social-root.ts';
import { registerPwa } from './pwa.ts';
import { getPublicRuntime } from './nostr-runtime.ts';
import { art } from './art.ts';
import { renderDescription } from './description.ts';
import { setupAI } from './ai-ui.ts';
import { setupLongPress } from './long-press.ts';
import { rankListings } from './ranking.ts';
import {setupUserLocation} from './user-location.ts';
import { setupProfiles, createRelationshipBadge } from './profile-ui.ts';
import { DEFAULT_SOCIAL_GRAPH_ROOT, loadCurationContext, profileLabel } from './profiles.ts';
import { setupMap } from './map-ui.ts';
import {setupLocationInputs} from './location-filter-ui.ts';
import {listingMatchesNearby,nearbyViewport,NEARBY_LABEL,type NearbyPoint} from './location-filter.ts';
import {geohashQueryForViewport} from './map/geohash.ts';
import { setupAccount } from './account-ui.ts';
import { setupComposer } from './composer.ts';
import { listingEnquiry } from './listing-actions.ts';
import { setupListingGrid } from './listing-grid.ts';
import { createHiddenListings, wantsPhotos, installListingMenus, listingMenu } from './listing-visibility.ts';
import { imageUrl, readImageSettings, saveImageSettings, createStaticImage } from './media.ts';
import { setupWallet } from './wallet-ui.ts';
import { setupOrders } from './orders-ui.ts';
import { setupRates, formatPrice, DEFAULT_CURRENCY, CURRENCIES } from './currency.ts';
import { setupPeople, createUserRow, nameFor, warmProfiles, resetPeople, refreshPeople } from './people.ts';
setupTheme();
setupHeaderMenu();
void registerPwa();
const $=byId;
const params=new URLSearchParams(location.search);
let preview=params.get('preview')==='1', side='offer', category='all', savedOnly=false, listings=[], client;
let detailReviews:ReturnType<typeof setupProductReviews>|undefined, detailReviewsKey='';
function closeDetailReviews(){detailReviews?.destroy();detailReviews=undefined;detailReviewsKey='';}
let detailAreaPreview:ReturnType<typeof setupServiceAreaPicker>|undefined,detailAreaKey='';
function closeDetailAreas(){void detailAreaPreview?.destroy();detailAreaPreview=undefined;detailAreaKey='';}
let toastTimer, focusedListing=null, aiFilter, aiCandidates=[], discoveryQuery='', submittedTextQuery='';
let discoveryAbort=new AbortController(),detailRenderKey='';
let userLocation:ReturnType<typeof setupUserLocation>;
function discoverSearch(query:string){discoveryQuery=query;discoveryAbort.abort();discoveryAbort=new AbortController();const active=client;active.searchTags(query);if(!query||!aiFilter?.enabled())return;const tags=active.tagCatalogue.entries().flatMap(entry=>entry.spellings).slice(0,128);void aiFilter.planTags(query,tags,discoveryAbort.signal).then(selected=>{if(selected.length&&active===client&&query===discoveryQuery&&aiFilter?.enabled())active.searchTags(query,selected);});}
const load=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}};
const persist=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value))}catch{toast('Storage is unavailable')}};
const savedData=load('market-saved-'+(preview?'preview':'live'),[]);
let saved=new Set((Array.isArray(savedData)?savedData:[]).filter(x=>typeof x==='string').slice(0,1000));
let feedTags=[], feedAuthors=null, feedNetwork=false, locationFilter='', shipsTo='';
let photoFilter:boolean|null=null, mapVisible=false;
const hiddenListings=createHiddenListings({getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)},'market-hidden-'+(preview?'preview':'live'));
const stopListingMenus=installListingMenus();
window.addEventListener('pagehide',stopListingMenus);
function photosOnly(){return wantsPhotos(photoFilter,{saved:savedOnly,map:mapVisible,query:aiFilter?.enabled()?aiFilter.query?.()||'':submittedTextQuery,side,category,location:locationFilter,shipsTo,tags:feedTags,authors:feedAuthors,network:feedNetwork});}
function refreshHiddenCount(){$('hidden-count').textContent=hiddenListings.count()?`${hiddenListings.count()} hidden`:'No hidden listings';$('restore-hidden').disabled=!hiddenListings.count();}
function toggleHidden(listing){try{gridUI.pin();if(hiddenListings.has(listing.id)){hiddenListings.show(listing.id);toast('Listing restored');}else{hiddenListings.hide(listing.id);toast('Listing hidden');}render();refreshProfileListings();refreshHiddenCount();}catch(error){toast(error.message||'Could not save this preference.');}}
let nearbyFilter:NearbyPoint|null=null;
const locationInputs=setupLocationInputs({shipsTo:$('ships-to'),shipsButton:$('ships-to-locate'),location:$('location'),nearButton:$('location-locate'),error:$('filter-error'),dialog:$('filters-dialog')});
let shippingResolver=createShippingResolver({query:(filters,options)=>getPublicRuntime(relays).query(filters,options)}),shippingRequest,shippingBusy=false,shippingFingerprint='';
const countryNames=new Intl.DisplayNames(undefined,{type:'region'});
const countryName=code=>countryNames.of(code)||code;
for(const code of [...COUNTRY_CODES].sort((a,b)=>countryName(a).localeCompare(countryName(b)))){const option=nodeOption(code,countryName(code));$('ships-to').append(option);}
function nodeOption(value,label){const option=document.createElement('option');option.value=value;option.textContent=label;return option;}
function resetShipping(){shippingRequest?.abort();shippingRequest=null;shippingBusy=false;shippingFingerprint='';}
async function loadShippingDetails(){
  if(!shipsTo||preview||shippingBusy)return;
  const rows=listings.slice(0,1000),fingerprint=JSON.stringify([shipsTo,relays,rows.map(item=>item.eventId)]);if(fingerprint===shippingFingerprint)return;
  shippingFingerprint=fingerprint;const controller=new AbortController();shippingRequest=controller;shippingBusy=true;
  try{for(let page=0;page<16;page++){const result=await shippingResolver.load(rows,{signal:controller.signal});if(controller!==shippingRequest)return;render();if(!result.hasMore)break;}}
  catch(error){if(error.name!=='AbortError')toast('Delivery details are unavailable. Try refreshing.');}
  finally{if(controller===shippingRequest){shippingRequest=null;shippingBusy=false;render();}}
}
let refreshProfileListings=()=>{};
let profiles, mapUI, accountUI, walletUI, ordersUI, composerUI, detailClient, courierClient, courierListings=[], routeReady=false, currentRoute=parseMarketRoute(location.href), visibleResult=[], graphContext, graphAbort;
let contextKey=load('market-graph-context',DEFAULT_SOCIAL_GRAPH_ROOT);
if(!/^[0-9a-f]{64}$/.test(contextKey||''))contextKey=DEFAULT_SOCIAL_GRAPH_ROOT;
let relays=load('market-relays',DEFAULT_RELAYS);
try { relays=validateRelays(relays); if(!relays.length)relays=DEFAULT_RELAYS; } catch { relays=DEFAULT_RELAYS; }
// Local browser acceptance can use an isolated relay; production URLs ignore it.
if(['127.0.0.1','localhost'].includes(location.hostname)&&params.has('test-relay')){try{const testRelay=new URL(params.get('test-relay'));if(testRelay.protocol==='ws:'&&['127.0.0.1','localhost'].includes(testRelay.hostname))relays=validateRelays([testRelay.href]);}catch{}}
let preferredCurrency=load('market-currency',DEFAULT_CURRENCY);
if(!CURRENCIES.includes(preferredCurrency))preferredCurrency=DEFAULT_CURRENCY;
let rateService;
const priceFor=l=>formatPrice(l,{preferredCurrency,rates:rateService?.snapshot()});
function priceNode(l,className){const info=priceFor(l),price=node('p',undefined,className);price.append(node('span',info.primary));if(info.original&&className==='detail-price')price.append(node('small',info.original+(info.stale?' · Last known rate':''),'original-price'));if(info.source){const note=`${info.source} · ${info.stale?'Last known':'Retrieved'} ${new Date(info.updatedAt*1000).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}`;price.title=note;if(className==='detail-price')price.append(node('small',note,'original-price'));}return price;}

const bookmark='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.4 5.4 0 0 0-7.6 0L12 5.8l-1.2-1.2a5.4 5.4 0 0 0-7.6 7.6L12 21l8.8-8.8a5.4 5.4 0 0 0 0-7.6Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
const node = domElement;
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,2500);}
function save(l){gridUI.pin();if(saved.has(l.id))saved.delete(l.id);else if(saved.size<1000)saved.add(l.id);else return toast('Saved-listing limit reached');persist('market-saved-'+(preview?'preview':'live'),[...saved]);render();refreshProfileListings();if(focusedListing)openDetail(focusedListing,false);}
function photo(l,className?:string){return createStaticImage(l.imageUrl,{width:className==='detail-art'?900:480,className,alt:l.title||'Listing photo',fallback:art(l)});}
function internalLink(link,href,onClick){link.href=routeHref(href);link.onclick=event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onClick();};}
function card(l){const el=node('article',undefined,'listing-card'),media=node('div',undefined,'card-image'),open=node('a',undefined,'card-open');open.setAttribute('aria-label',`View ${l.title}`);open.append(photo(l));internalLink(open,listingURL(l.id,location.href),()=>openDetail(l));const button=node('button',undefined,'save-button');button.innerHTML=bookmark;button.querySelector('path').setAttribute('fill',saved.has(l.id)?'currentColor':'none');button.setAttribute('aria-label',`${saved.has(l.id)?'Unsave':'Save'} ${l.title}`);button.setAttribute('aria-pressed',String(saved.has(l.id)));button.onclick=()=>save(l);media.append(open,button);if(l.side==='request')media.append(node('span','Buying','request-badge'));const title=node('a',l.title,'card-title');internalLink(title,listingURL(l.id,location.href),()=>openDetail(l));const titleRow=node('div',undefined,'card-title-row');titleRow.append(title,listingMenu(l.title,hiddenListings.has(l.id),()=>toggleHidden(l)));el.append(media,titleRow,priceNode(l,'card-price'),node('p',l.location||'Anywhere','card-location'));if(!preview&&l.author)el.append(authorButton(l));return el;}
function authorButton(l){return createUserRow(l.author,{className:'author-button',onClick:()=>profiles.open(l.author)});}
function routeHref(href){const url=new URL(href);if(preview)url.searchParams.set('preview','1');if(['127.0.0.1','localhost'].includes(location.hostname)&&params.has('test-relay'))url.searchParams.set('test-relay',params.get('test-relay'));return url.href;}
function navigate(href,{activate=true,replace=false}={}){href=routeHref(href);if(location.href===href){if(activate)activateRoute();return;}history.replaceState({...history.state,marketScroll:window.scrollY},'',location.href);history[replace?'replaceState':'pushState']({marketInternal:true},'',href);currentRoute=parseMarketRoute(href);frameRoute();if(activate)activateRoute();window.scrollTo(0,0);}
function backToBrowse(){if(history.state?.marketInternal)history.back();else navigate(pageURL('',location.href));}
function frameRoute(){const type=currentRoute.type;document.title=({home:'Iris Market',saved:'Saved · Iris Market',profile:'Profile · Iris Market',post:'Post a listing · Iris Market',messages:'Messages · Iris Market',orders:'Orders · Iris Market',wallet:'Wallet · Iris Market',settings:'Settings · Iris Market',account:'Profile settings · Iris Market',courier:'Transport · Iris Market'}[type]||'Iris Market');const browsing=type==='home'||type==='saved';const skip=document.querySelector<HTMLAnchorElement>('.skip');skip.textContent='Skip to content';skip.href=browsing?'#main':type==='profile'?'#profile-page':['listing','missing'].includes(type)?'#listing-page':'#workspace-page';$('main').hidden=!browsing;$('listing-page').hidden=!['listing','missing'].includes(type);$('profile-page').hidden=type!=='profile';$('workspace-page').hidden=browsing||['listing','missing','profile'].includes(type);$('preferences-dialog').hidden=type!=='settings';if(type!=='profile')profiles?.close({notify:false});if(type!=='account')accountUI?.hideAccount();if(type!=='messages')accountUI?.hideInbox();if(!['orders','courier'].includes(type))ordersUI?.hide();if(type!=='wallet')walletUI?.hide();if(type!=='post')composerUI?.hide({preservePending:type==='account'});if(type!=='listing'){detailRenderKey='';closeDetailReviews();closeDetailAreas();focusedListing=null;detailClient?.close();detailClient=null;}gridUI.setVisible(browsing&&!$('listings').hidden);for(const [id,active] of [['browse-tab',type==='home'],['saved-tab',type==='saved'],['orders-tab',['orders','courier'].includes(type)],['inbox-tab',type==='messages'],['wallet-tab',type==='wallet']] as const)$(id).classList.toggle('active',active);syncCourierFeed();}
function activateRoute(){if(!routeReady)return;userLocation?.closeChooser();currentRoute=parseMarketRoute(location.href);frameRoute();const route=currentRoute;if(route.type==='home'||route.type==='saved'){savedOnly=route.type==='saved';render();return;}if(route.type==='listing'){const found=listings.find(l=>l.id===route.id)||focusedListing;if(found?.id===route.id)openDetail(found,false);else{closeDetailReviews();closeDetailAreas();focusedListing=null;$('detail-content').replaceChildren(node('h1','Listing'),node('p','This listing hasn’t arrived yet. You can keep browsing.','muted'));}if(!preview&&client?.targetId!==route.id&&detailClient?.targetId!==route.id){detailClient?.close();detailClient=new MarketRelayClient({relays,authors:[],targetId:route.id,maxRecords:8,onChange:rows=>{if(currentRoute.type==='listing'&&currentRoute.id===route.id){const value=rows.find(l=>l.id===route.id);if(value)openDetail(value,false);else if(detailClient?.records.has(route.id))unavailableListing();}}});detailClient.start();}return;}if(route.type==='profile'){void profiles.open(route.pubkey,{navigate:false});return;}if(route.type==='post'){composerUI.open();return;}if(route.type==='wallet'){void walletUI.open();return;}if(route.type==='messages'){if(route.pubkey)void accountUI.openChat(route.pubkey);else accountUI.showInbox();return;}if(route.type==='account'){accountUI.showAccount();return;}if(route.type==='courier'){ordersUI.open(undefined,'deliveries');return;}if(route.type==='orders'){ordersUI.open(route.id,route.id?undefined:'purchases');return;}if(route.type==='missing')$('detail-content').replaceChildren(node('h1','Page not found'),node('p','Check the link or return to Browse.','muted'));}
function pageOpened(href){if(!routeReady)return;navigate(href,{activate:false});}
function unreadNav(id,count){const button=$(id);let dot=button.querySelector('.nav-unread');if(!dot){dot=node('span',undefined,'nav-unread');dot.setAttribute('aria-hidden','true');button.append(dot);}dot.hidden=count===0;if(id==='orders-tab'){dot.classList.add('nav-unread-count');dot.textContent=count>99?'99+':String(count);}button.setAttribute('aria-label',`${id==='inbox-tab'?'Messages':'Orders'}${count?`, ${count} unread`:''}`);}
function render(){void loadShippingDetails();const submitted=aiFilter?.enabled()?aiFilter.query?.()||'':submittedTextQuery;if(client&&submitted!==discoveryQuery){discoverSearch(submitted);}let result=listings.filter(l=>(savedOnly||!hiddenListings.has(l.id))&&(!photosOnly()||!!l.imageUrl)).filter(l=>(feedAuthors===null||feedAuthors.includes(l.author))&&(!feedNetwork||(graphContext?.rankRelationFor(l.author)||graphContext?.relationFor(l.author))?.distance===1)&&(!feedTags.length||feedTags.some(t=>(l.tags||[l.category]).includes(t)))).filter(l=>(!savedOnly||saved.has(l.id))&&(side==='all'||l.side===side)&&(category==='all'||(l.category||'').toLowerCase()===category));const query=(aiFilter?.enabled()?aiFilter.query?.()||'':submittedTextQuery).trim().toLowerCase(),place=locationFilter.toLowerCase();result=result.filter(l=>`${l.title} ${l.description} ${l.category} ${(l.tags||[]).join(' ')} ${l.location}`.toLowerCase().includes(aiFilter?.enabled()?'':query)&&(nearbyFilter?listingMatchesNearby(l,nearbyFilter):(l.location||'').toLowerCase().includes(place))&&(!shipsTo||matchesShippingDestination(shippingResolver.forListing(l),shipsTo)));if($('sort').value==='price')result.sort((a,b)=>{const av=priceFor(a).converted,bv=priceFor(b).converted;if(av!==null&&bv!==null)return av-bv;if(av!==null)return -1;if(bv!==null)return 1;return(a.currency||'').localeCompare(b.currency||'')||(a.price===''?Infinity:Number(a.price))-(b.price===''?Infinity:Number(b.price));});if($('sort').value!=='price')result=rankListings(result,{sort:$('sort').value as 'suggested'|'social'|'newest',saved,savedListings:listings,query,aiScoreFor:listing=>aiFilter?.scoreFor(listing),location:nearbyFilter||userLocation?.point(),relationFor:key=>graphContext?.rankRelationFor(key)||graphContext?.relationFor(key)});aiCandidates=result;result=result.filter(l=>!aiFilter||aiFilter.isVisible(l));visibleResult=result;gridUI.update(result,JSON.stringify([preview,savedOnly,side,category,query,place,nearbyFilter,shipsTo,$('sort').value,feedTags,feedAuthors,feedNetwork,contextKey,aiFilter?.enabled(),photosOnly()]));mapUI?.refresh();$('saved-count').textContent=String(saved.size);$('page-title').textContent=savedOnly?'Saved listings':'Listings';$('result-count').textContent=`${result.length} ${result.length===1?'listing':'listings'}`;$('empty').hidden=result.length!==0||!!aiFilter?.searching?.()||shippingBusy;$('empty-title').textContent=savedOnly?'No saved listings':query||place||shipsTo||category!=='all'||side!=='offer'||feedNetwork||feedTags.length?'No matches':'No listings yet';$('empty-description').textContent=savedOnly?'Tap a heart to save a listing.':query||place||shipsTo||category!=='all'||side!=='offer'||feedNetwork||feedTags.length?'Try another search or clear your filters.':'Refresh to check for new listings.';$('clear-filters').hidden=!(query||place||shipsTo||category!=='all'||side!=='offer'||feedNetwork||feedTags.length);$('browse-tab').classList.toggle('active',currentRoute.type==='home');$('saved-tab').classList.toggle('active',currentRoute.type==='saved');aiFilter?.refresh();}
function openDetail(l,update=true){if(update){focusedListing=l;navigate(listingURL(l.id,location.href));return;}focusedListing=l;const renderKey=JSON.stringify([l.eventId||l.id,saved.has(l.id),priceFor(l),readImageSettings(),accountUI?.state().ownerPubkey,preview]);if(detailRenderKey===renderKey&&$('detail-content').childElementCount)return;detailRenderKey=renderKey;const rawOpen=$('detail-content').querySelector<HTMLDetailsElement>('.listing-raw-event')?.open;const areaKey=l.serviceAreas?JSON.stringify(l.serviceAreas):'';if(areaKey!==detailAreaKey){closeDetailAreas();detailAreaKey=areaKey;if(l.serviceAreas)detailAreaPreview=setupServiceAreaPicker({value:l.serviceAreas,readOnly:true});}const detail=renderListingPage(l,{saved:saved.has(l.id),onSave:save,onBuy:value=>{const enquiry=listingEnquiry(value,location.href);if(value.side==='request')void accountUI.openChat(value.author,{draft:enquiry.draft});else ordersUI.buy(value);},onProfile:key=>profiles.open(key),priceNode,authorRow:authorButton,isPreview:preview,owner:accountUI?.state().ownerPubkey,onEdit:value=>composerUI.edit?.(value),onToast:toast});if(detailAreaPreview){const media=detail.querySelector('.detail-media');if(!l.imageUrl&&media){media.classList.add('detail-area-media');media.replaceChildren(detailAreaPreview.element);}else detail.append(detailAreaPreview.element);}if(!preview){if(detailReviewsKey!==l.id){closeDetailReviews();detailReviewsKey=l.id;detailReviews=setupProductReviews({listing:l,query:(filters,options)=>getPublicRuntime(relays).query(filters,options),onProfile:key=>profiles.open(key)});}detail.append(detailReviews.element);void detailReviews.start();}$('detail-content').replaceChildren(detail);if(rawOpen){const raw=detail.querySelector<HTMLDetailsElement>('.listing-raw-event');if(raw)raw.open=true;}if(detailAreaPreview)void detailAreaPreview.show();document.title=`${l.title} · Iris Market`;}
function start(){discoveryAbort.abort();client?.close();discoveryQuery='';aiFilter?.stop();listings=[];gridUI.reset();$('preview-note').hidden=!preview;$('mode-toggle').textContent=preview?'Live market':'Preview';$('refresh').disabled=preview;render();if(preview){listings=previewListings;$('network-status').textContent='Preview';$('network-status').classList.remove('live');render();showShared();return;}try { client=new MarketRelayClient({relays,tags:feedTags,authors:feedAuthors,targetId:currentRoute.type==='listing'?currentRoute.id:undefined,onChange(data){listings=data;render();showShared()},onPagination:()=>render(),onStatus(status){$('network-status').textContent=status.state==='live'?`${status.connected} ${status.connected===1?'relay':'relays'}`:status.state==='offline'?'Relays unavailable':status.message||'Connecting…';$('network-status').classList.toggle('live',status.state==='live')}});client.start(); if(nearbyFilter)client.setGeohashes(geohashQueryForViewport(nearbyViewport(nearbyFilter)));mapUI?.refreshDiscovery(); } catch(error) { $('network-status').textContent='Connection unavailable'; toast(error.message); }}
function syncCourierFeed(){
  if(currentRoute.type!=='courier'){courierClient?.close();courierClient=null;courierListings=[];return;}
  if(preview||courierClient)return;
  const active=new MarketRelayClient({relays,tags:['transport','courier','parcel','parcels','delivery','deliveries','passenger','ride'],offlineCache:null,
    onChange:rows=>{if(courierClient!==active)return;courierListings=rows;ordersUI?.refreshCourier();},
    onPagination:()=>ordersUI?.refreshCourier()});
  courierClient=active;active.start();
}
function courierCard(listing){
  const row=node('article',undefined,'courier-gig'),head=node('div',undefined,'courier-gig-head'),link=node('a',listing.title,'courier-gig-title');
  internalLink(link,listingURL(listing.id,location.href),()=>openDetail(listing));head.append(link,priceNode(listing,'courier-gig-price'));
  row.append(head,node('p',listing.location||'Area not specified','small muted'));
  if(listing.author)row.append(authorButton(listing));
  const view=node('a',listing.side==='request'?'View request':'View listing','text-button');internalLink(view,listingURL(listing.id,location.href),()=>openDetail(listing));row.append(view);return row;
}
function unavailableListing(){detailRenderKey='';closeDetailReviews();closeDetailAreas();focusedListing=null;$('detail-content').replaceChildren(node('h1','Listing unavailable'),node('p','This listing is no longer available.','muted'));}
function showShared(){if(currentRoute.type!=='listing')return;const id=currentRoute.id;const l=listings.find(l=>l.id===id);if(l)openDetail(l,false);else if(client?.records.has(id)||focusedListing?.expiration!==null&&focusedListing?.expiration<=Date.now()/1000)unavailableListing();}
$('sort').onchange=render;
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-side]'))b.onclick=()=>{side=b.dataset.side;document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b))});render()};
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-category]'))b.onclick=()=>{category=b.dataset.category;document.querySelectorAll<HTMLButtonElement>('[data-category]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b))});render()};
$('browse-tab').onclick=()=>navigate(pageURL('',location.href));$('saved-tab').onclick=()=>navigate(pageURL('saved',location.href));$('clear-filters').onclick=()=>{photoFilter=null;feedNetwork=false;feedTags=[];feedAuthors=null;locationFilter='';nearbyFilter=null;shipsTo='';resetShipping();updateFilterSummary();start();$('search').value='';submittedTextQuery='';$('location').value='';document.querySelector<HTMLButtonElement>('[data-side="offer"]').click();document.querySelector<HTMLButtonElement>('[data-category="all"]').click()};
$('mode-toggle').onclick=()=>{const u=new URL(location.href);u.searchParams.delete('listing');if(preview)u.searchParams.delete('preview');else u.searchParams.set('preview','1');location.assign(u)};
$('refresh').onclick=()=>{resetShipping();shippingResolver.invalidate();gridUI.reset();client?.refresh();render()};
for(const d of document.querySelectorAll('dialog')){d.querySelector<HTMLButtonElement>('.dialog-close').onclick=()=>d.close();dismissOnBackdrop(d);}
$('listing-back').onclick=event=>{event.preventDefault();backToBrowse();};
$('workspace-page').append($('preferences-dialog'));$('preferences-dialog').querySelector<HTMLButtonElement>('.dialog-close').onclick=backToBrowse;
$('relay-settings').onclick=()=>{$('relay-input').value=relays.join('\n');$('relay-error').textContent='';$('relays-dialog').showModal()};
$('relay-form').onsubmit=e=>{e.preventDefault();const values=[...new Set($('relay-input').value.split('\n').map(x=>x.trim()).filter(Boolean))];if(!values.length||values.length>8)return $('relay-error').textContent='Choose between one and eight relays.';try{for(const raw of values){const u=new URL(raw);if(u.protocol!=='wss:'||u.username||u.password||u.hash||u.search)throw Error()}}catch{return $('relay-error').textContent='Use wss:// relay addresses without credentials.'}relays=values;resetShipping();shippingResolver=createShippingResolver({query:(filters,options)=>getPublicRuntime(relays).query(filters,options)});resetPeople();persist('market-relays',relays);$('relays-dialog').close();start();loadGraph();void rateService?.refresh();if(accountUI.state().status==='ready')void accountUI.messaging.reconnect().catch(error=>toast(error.message));};
document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!$('main').hidden&&!document.querySelector('dialog[open]')){e.preventDefault();$('search').focus()}});
function networkFilterLabel(){return accountUI?.state().ownerPubkey===contextKey?'People I follow':contextKey===DEFAULT_SOCIAL_GRAPH_ROOT?'Sirius Business’s network':nameFor(contextKey)+'’s network';}
$('feed-filters').onclick=()=>{$('has-photos').checked=photosOnly();$('location').value=locationFilter;locationInputs.restore(nearbyFilter);$('ships-to').value=shipsTo;$('tag-input').value=feedTags.join(', ');$('audience').value=feedNetwork?'following':'all';$('audience').querySelector('option[value="following"]').textContent=networkFilterLabel();$('filter-error').textContent='';$('filters-dialog').showModal()};
function updateFilterSummary(){const parts=[];if(photoFilter===true)parts.push('Has photos');if(shipsTo)parts.push('Ships to '+countryName(shipsTo));if(locationFilter)parts.push(locationFilter);if(feedTags.length)parts.push(feedTags.map(t=>'#'+t).join(' '));if(feedNetwork)parts.push(networkFilterLabel());$('filter-summary').hidden=!parts.length;$('filter-summary').textContent=parts.join(' · ');}
$('reset-feed-filters').onclick=()=>{photoFilter=null;feedTags=[];feedAuthors=null;feedNetwork=false;locationFilter='';nearbyFilter=null;shipsTo='';resetShipping();$('filters-dialog').close();updateFilterSummary();start()};
$('filter-form').onsubmit=e=>{e.preventDefault();const tags=[...new Set($('tag-input').value.split(',').map(t=>t.trim().replace(/^#/, '')).filter(Boolean))];if(tags.length>8||tags.some(t=>t.length>60))return $('filter-error').textContent='Use up to eight tags, each under 60 characters.';photoFilter=$('has-photos').checked;nearbyFilter=locationInputs.pending();locationFilter=nearbyFilter?NEARBY_LABEL:$('location').value.trim();shipsTo=$('ships-to').value;resetShipping();feedTags=tags;feedNetwork=$('audience').value==='following';feedAuthors=null;$('filters-dialog').close();updateFilterSummary();start()};
async function loadGraph(){
  graphAbort?.abort();graphContext=null;graphAbort=new AbortController();
  $('graph-context').textContent=contextKey===DEFAULT_SOCIAL_GRAPH_ROOT?'Sirius Business network':nameFor(contextKey)+' network';
  if(preview){$('curation-status').textContent='Preview · social data stays offline';return;}
  $('curation-status').textContent='Loading public connections…';
  const active=graphAbort;
  try{const result=await loadCurationContext({relays,contextPubkey:contextKey,targetAuthors:listings.map(item=>item.author),signal:active.signal});if(active!==graphAbort)return;graphContext=result;rootChoice.observe(result);if(result.contextPubkey!==contextKey)return;$('curation-status').textContent=result.coverage.rootLoaded?`${result.coverage.directFollows} follows · ${result.coverage.bootstrap?'snapshot + live updates':'partial network'}`:'Connections unavailable';render();}catch(error){if(error.name!=='AbortError')$('curation-status').textContent='Connections unavailable';}
}
const gridUI=setupListingGrid({grid:$('listings'),controls:$('grid-pagination'),button:$('load-more'),status:$('grid-progress'),makeCard:card,
  cardKey:l=>JSON.stringify([l.eventId||l.id,priceFor(l).primary,saved.has(l.id),hiddenListings.has(l.id),graphContext?.relationFor(l.author),readImageSettings()]),
  olderState:()=>{const remote=preview||savedOnly?{hasMore:false}:client?.pagination?.()||{hasMore:false};const ai=aiFilter?.enabled()&&aiFilter.query?.()?aiFilter.pagination?.():null;return ai?{...remote,hasMore:ai.hasMore||remote.hasMore,loading:ai.loading||remote.loading,error:ai.error||remote.error,paused:ai.paused}:remote;},
  loadOlder:async()=>{try{if(aiFilter?.enabled()&&aiFilter.query?.()){await aiFilter.loadMore();}else await client?.loadOlder?.();}catch{}render()}});
refreshHiddenCount();$('restore-hidden').onclick=()=>{try{hiddenListings.clear();refreshHiddenCount();render();refreshProfileListings();toast('Listings restored');}catch{toast('Could not save this preference.');}};
const imageSettings=readImageSettings();$('image-proxy-enabled').checked=imageSettings.useProxy;$('image-proxy-url').value=imageSettings.url;
$('image-settings-form').onsubmit=e=>{e.preventDefault();try{saveImageSettings({...readImageSettings(),useProxy:$('image-proxy-enabled').checked,url:$('image-proxy-url').value});$('image-settings-error').textContent='';refreshPeople();render();if(focusedListing)openDetail(focusedListing,false);toast('Image settings saved')}catch(error){$('image-settings-error').textContent=error.message}};
setupPeople({getRelays:()=>relays,isPreview:()=>preview,relationshipFor:key=>graphContext?.relationFor(key),makeRelationshipBadge:createRelationshipBadge,onChange:()=>{updateFilterSummary();if(contextKey!==DEFAULT_SOCIAL_GRAPH_ROOT)$('graph-context').textContent=nameFor(contextKey)+' network'}});
function renderProfileListings(pubkey,host){
  const grid=node('div',undefined,'listing-grid'),empty=node('p','No listings yet.','muted profile-listings-empty');
  const controls=node('div',undefined,'grid-pagination'),button=node('button','Load more','button secondary'),status=node('span',undefined,'small muted');
  button.type='button';controls.append(button,status);host.replaceChildren(grid,empty,controls);
  let feed,disposed=false,rows=listings.filter(l=>l.author===pubkey);
  const update=()=>{if(disposed)return;const visible=rows.filter(l=>!hiddenListings.has(l.id));empty.hidden=visible.length>0;view.update(visible,pubkey)};
  const view=setupListingGrid({grid,controls,button,status,makeCard:card,cardKey:l=>JSON.stringify([l.eventId||l.id,priceFor(l).primary,saved.has(l.id),hiddenListings.has(l.id)]),olderState:()=>feed?.pagination()||{hasMore:false},loadOlder:()=>feed?.loadOlder()});
  update();refreshProfileListings=update;
  if(!preview){
    const records=new Map<string,MarketListing>([...(client?.records?.entries()||[])].filter(([,l])=>l.author===pubkey));
    feed=new MarketRelayClient({relays,authors:[pubkey],records,maxRecords:500,onChange:data=>{rows=data;update()},onPagination:update});
    feed.start();
  }
  return()=>{disposed=true;feed?.close();view.dispose();if(refreshProfileListings===update)refreshProfileListings=()=>{};};
}
const rootChoice=createSocialRootController({initialContext:contextKey,loadContext:(owner,{signal})=>loadCurationContext({relays,contextPubkey:owner,targetAuthors:listings.map(item=>item.author),signal}),onChange:selection=>{const changed=selection.root!==contextKey;contextKey=selection.root;if(selection.context){graphAbort?.abort();graphContext=selection.context;$('graph-context').textContent=nameFor(contextKey)+' network';render();refreshPeople();}else if(changed)loadGraph();updateFilterSummary();}});
window.addEventListener('pagehide',()=>rootChoice.dispose());
profiles=setupProfiles({page:$('profile-page'),onNavigate:key=>pageOpened(profileURL(key,location.href)),onClose:backToBrowse,getRelays:()=>relays,getContext:()=>contextKey,isPreview:()=>preview,onContextChange:key=>{persist('market-graph-context',key);rootChoice.selectContext(key)},onMessage:key=>accountUI.openChat(key).catch(error=>toast(error.message)),renderListings:renderProfileListings,
  queryReviews:(filters,options)=>getPublicRuntime(relays).query(filters,options),
  getReviewAccount:()=>({owner:accountUI?.state().ownerPubkey,canSign:!!accountUI?.state().canSign,pending:accountUI?.state().pendingReviews}),
  publishReview:draft=>accountUI.messaging.publishEvent(draft),onReviewSignIn:()=>accountUI.showAccount({posting:true})});
$('graph-context').onclick=()=>profiles.open(contextKey);
accountUI=setupAccount({accountPage:$('workspace-page'),onAccountPage:()=>pageOpened(pageURL('settings/profile',location.href)),onAccountClose:backToBrowse,messagePage:$('workspace-page'),onMessagePage:key=>pageOpened(pageURL('messages'+(key?'/'+npubEncode(key):''),location.href)),onMessageClose:backToBrowse,onUnread:count=>unreadNav('inbox-tab',count),getRelays:()=>relays,isPreview:()=>preview,onProfile:key=>profiles.open(key),onOrder:id=>ordersUI?.open(id),onToken:token=>walletUI?.openToken(token),onIdentity:(key,status,previous,pending)=>{$('my-listings-menu').hidden=!key||preview;rootChoice.setIdentity(key||null,previous);if(client){let changed=false;for(const event of pending)try{changed=applyEvent(client.records,event)||changed}catch{}if(changed)client.emitChange();refreshPeople();}}});
accountUI.onState(()=>profiles?.refreshReviews());
composerUI=setupComposer({priceNode,page:$('workspace-page'),onNavigate:()=>pageOpened(pageURL('post',location.href)),onClose:backToBrowse,account:accountUI,isPreview:()=>preview,defaultCurrency:()=>preferredCurrency,onPublished:(event,receipt)=>{if(client){applyEvent(client.records,event);client.emitChange();}toast(receipt?.accepted?.length?'Listing published':'Listing queued');}});
ordersUI=setupOrders({page:$('workspace-page'),onNavigate:(id,tab)=>pageOpened(pageURL(id?'orders/'+encodeURIComponent(id):tab==='deliveries'?'courier':'orders',location.href)),onClose:backToBrowse,onUnread:count=>unreadNav('orders-tab',count),account:accountUI,isPreview:()=>preview,onProfile:key=>profiles.open(key),onReview:key=>profiles.openReviews(key),courier:{getListings:()=>courierListings,onListing:openDetail,onAnnounce:draft=>composerUI.prefill(draft),onEditListing:listing=>composerUI.edit(listing),renderListing:courierCard,loadMore:async()=>{const active=courierClient;if(!active)return;const page=await active.loadOlder();if(page.error)throw new Error(page.error);},pagination:()=>courierClient?.pagination()||{}},formatPrice:item=>priceFor(item).primary});
$('orders-tab').onclick=()=>navigate(pageURL('orders',location.href));$('post-button').onclick=()=>navigate(pageURL('post',location.href));$('inbox-tab').onclick=()=>navigate(pageURL('messages',location.href));
walletUI=setupWallet({page:$('workspace-page'),onNavigate:()=>pageOpened(pageURL('wallet',location.href)),onClose:backToBrowse,isPreview:()=>preview,onShareMessage:text=>accountUI.composeMessage(text),formatEstimate:amount=>{const price=priceFor({price:amount,currency:'SATS'});return price.original?price.primary:''}});
$('my-listings-menu').onclick=()=>{const owner=accountUI.state().ownerPubkey;if(owner)profiles.open(owner);};
$('courier-menu').onclick=()=>navigate(pageURL('courier',location.href));$('manage-profile').onclick=()=>navigate(pageURL('settings/profile',location.href));$('wallet-tab').onclick=()=>navigate(pageURL('wallet',location.href));$('appearance-settings').onclick=()=>navigate(pageURL('settings',location.href));
mapUI=setupMap({getListings:()=>visibleResult,onSelect:openDetail,onVisibilityChange:visible=>{mapVisible=visible;gridUI.setVisible(!visible&&['home','saved'].includes(currentRoute.type));render();},onDiscover:cells=>{if(!preview)client?.setGeohashes(cells.length?cells:nearbyFilter?geohashQueryForViewport(nearbyViewport(nearbyFilter)):[])},isDiscoveryLimited:()=>!preview&&!!client?.pagination().limited});
for(const currency of CURRENCIES){const option=node('option',currency==='SATS'?'Satoshis':currency);option.value=currency;$('preferred-currency').append(option);}$('preferred-currency').value=preferredCurrency;$('preferred-currency').onchange=()=>{preferredCurrency=$('preferred-currency').value;persist('market-currency',preferredCurrency);render();walletUI?.refresh();ordersUI?.refresh(accountUI.state());if(focusedListing)openDetail(focusedListing,false)};
if(!preview)rateService=setupRates({getRelays:()=>relays,onChange:()=>{render();if(focusedListing)openDetail(focusedListing,false)}});
window.addEventListener('popstate',()=>{activateRoute();requestAnimationFrame(()=>window.scrollTo(0,history.state?.marketScroll||0));});
userLocation=setupUserLocation({onChange:render,isPreview:preview});$('your-location-filters').append(userLocation.createControl());$('your-location-settings').append(userLocation.createControl());
const disposeAIOptionsGesture=setupLongPress($('search-mode'),()=>{
  navigate(pageURL('settings',location.href));
  const model=$('ai-model');
  const group=model.closest('details');
  if(group)group.open=true;
  const label=model.closest('label');
  if(label)label.hidden=false;
  model.focus();
});
window.addEventListener('pagehide',()=>{disposeAIOptionsGesture();userLocation?.dispose();discoveryAbort.abort();closeDetailReviews();closeDetailAreas();client?.close();detailClient?.close();courierClient?.close();profiles?.close({notify:false});graphAbort?.abort();rateService?.close();gridUI.dispose()});aiFilter=setupAI({autoPrepare:!preview,getCandidates:()=>aiCandidates,onChange:render,onTextSearch:query=>{submittedTextQuery=query;},fetchMoreCandidates:async()=>{
  if(preview||savedOnly||!client)return false;
  const active=client,queryPage=active.queryPagination();
  if(queryPage.loading||queryPage.hasMore){
    const targeted=await active.loadQueryCandidates();
    if(active!==client)return false;
    if(targeted.added>0||targeted.hasMore&&!targeted.error)return true;
    if(targeted.error&&!active.pagination().hasMore)throw new Error('Could not load more listings');
  }
  if(!active.pagination().hasMore)return false;
  const page=await active.loadOlder();
  if(active!==client)return false;
  if(page.error)throw new Error('Could not load more listings');
  return page.added>0||page.hasMore;
}});routeReady=true;start();activateRoute();loadGraph();
