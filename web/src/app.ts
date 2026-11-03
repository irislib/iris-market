import {setupBitcoinOrders} from './bitcoin-orders-ui.ts';
import {planTopicFilters} from './semantic-discovery.ts';
import {fiatMethodLabel,fiatQuoteLabel} from './escrow-offer.ts';
import {marketplaceToolEnabled} from './marketplace-tools.ts';
import {setupEscrowTrade} from './escrow-trade-ui.ts';
import {orderContext} from './message-context.ts';
import {listingContext} from './message-context.ts';
import {matchesLiteralSearch,listingSearchText} from './lexical-search.ts'
import { npubEncode } from 'nostr-tools/nip19';
import { parseMarketRoute, searchURL, listingURL, profileURL, pageURL } from './routes.ts';
import { dismissOnBackdrop } from './surface.ts';
import { renderListingPage } from './listing-page.ts';
import { setupProductReviews } from './product-reviews-ui.ts';
import {setupServiceAreaPicker} from './service-area-ui.ts';
import { byId, element as domElement, formFields } from './dom.ts';
import { MarketRelayClient, DEFAULT_RELAYS, validateRelays, parseEvent, applyEvent, type MarketListing } from './market.ts';
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
import {loadHomeFeed,saveHomeFeed} from './home-feed.ts';
import {createSearchDiscovery} from './search-discovery.ts';
import { relatedSearchLabels } from './seen-tags.ts';
import { rankListings } from './ranking.ts';
import {setupUserLocation} from './user-location.ts';
import { setupProfiles, createRelationshipBadge } from './profile-ui.ts';
import { DEFAULT_SOCIAL_GRAPH_ROOT, loadCurationContext, profileLabel } from './profiles.ts';
import { setupMap } from './map-ui.ts';
import {setupLocationInputs} from './location-filter-ui.ts';
import {listingMatchesNearby,nearbyViewport,NEARBY_LABEL,type NearbyPoint} from './location-filter.ts';
import {decodeGeohash,locationHash,geohashQueryForViewport} from './map/geohash.ts';
import { setupAccount } from './account-ui.ts';
import { setupComposer } from './composer.ts';
import { listingEnquiry } from './listing-actions.ts';
import { setupListingGrid } from './listing-grid.ts';
import { createHiddenListings, wantsPhotos, installListingMenus, listingMenu } from './listing-visibility.ts';
import { imageUrl, readImageSettings, saveImageSettings, createStaticImage } from './media.ts';
import { setupWallet } from './wallet-ui.ts';
import { setupOrders } from './orders-ui.ts';
import { setupRates, formatPrice, formatWalletAmount, initialCurrency, DEFAULT_CURRENCY, CURRENCIES } from './currency.ts';
import { setupPeople, createUserRow, nameFor, warmProfiles, resetPeople, refreshPeople } from './people.ts';
setupTheme();
setupHeaderMenu();
void registerPwa();
const $=byId;
const bitcoinOrders=setupBitcoinOrders($('bitcoin-orders'),()=>render());
const params=new URLSearchParams(location.search);
let preview=params.get('preview')==='1', side='offer', category='all', savedOnly=false, listings=[], client;
let detailReviews:ReturnType<typeof setupProductReviews>|undefined, detailReviewsKey='';
function closeDetailReviews(){detailReviews?.destroy();detailReviews=undefined;detailReviewsKey='';}
let detailAreaPreview:ReturnType<typeof setupServiceAreaPicker>|undefined,detailAreaKey='';
function closeDetailAreas(){void detailAreaPreview?.destroy();detailAreaPreview=undefined;detailAreaKey='';}
let toastTimer, focusedListing=null, aiFilter, aiCandidates=[], submittedTextQuery='';
let detailRenderKey='';
let userLocation:ReturnType<typeof setupUserLocation>;
const searchDiscovery=createSearchDiscovery({getClient:()=>client,getAI:()=>aiFilter,planTopics:planTopicFilters,onPlanChange:updateFilterSummary});
const load=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}};
const persist=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value))}catch{toast('Storage is unavailable')}};
const savedData=load('market-saved-'+(preview?'preview':'live'),[]);
let saved=new Set((Array.isArray(savedData)?savedData:[]).filter(x=>typeof x==='string').slice(0,1000));
let feedTags=[], feedAuthors=null, feedNetwork=false, locationFilter=decodeGeohash(params.get('g'))?'#'+params.get('g').toLowerCase():'', shipsTo='';
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
  if(savedOnly||!shipsTo||preview||shippingBusy)return;
  const rows=listings.slice(0,1000),fingerprint=JSON.stringify([shipsTo,relays,rows.map(item=>item.eventId)]);if(fingerprint===shippingFingerprint)return;
  shippingFingerprint=fingerprint;const controller=new AbortController();shippingRequest=controller;shippingBusy=true;
  try{for(let page=0;page<16;page++){const result=await shippingResolver.load(rows,{signal:controller.signal});if(controller!==shippingRequest)return;render();if(!result.hasMore)break;}}
  catch(error){if(error.name!=='AbortError')toast('Delivery details are unavailable. Try refreshing.');}
  finally{if(controller===shippingRequest){shippingRequest=null;shippingBusy=false;render();}}
}
let refreshProfileListings=()=>{};
const desktopSearchQuery=window.matchMedia('(min-width:900px)');
const searchRow=document.querySelector<HTMLElement>('.search-row'),searchAnchor=document.createComment('Search placement');
searchRow.before(searchAnchor);
function placeSearch() {
  if (desktopSearchQuery.matches && currentRoute.type === 'listing') {
    $('listing-page').prepend(searchRow);
  } else if (searchRow.previousSibling !== searchAnchor) {
    searchAnchor.after(searchRow);
  }
}
desktopSearchQuery.addEventListener('change',placeSearch);

let profiles, mapUI, accountUI, walletUI, ordersUI, composerUI, detailClient, courierClient, courierListings=[], routeReady=false, currentRoute=parseMarketRoute(location.href), visibleResult=[], graphContext, graphAbort;
let contextKey=load('market-graph-context',DEFAULT_SOCIAL_GRAPH_ROOT);
if(!/^[0-9a-f]{64}$/.test(contextKey||''))contextKey=DEFAULT_SOCIAL_GRAPH_ROOT;
let relays=load('market-relays',DEFAULT_RELAYS);
let useDiscoveryRelays=relays===DEFAULT_RELAYS;
try { relays=validateRelays(relays); if(!relays.length)relays=DEFAULT_RELAYS; } catch { relays=DEFAULT_RELAYS; }
// Local browser acceptance can use an isolated relay; production URLs ignore it.
if(['127.0.0.1','localhost'].includes(location.hostname)&&params.has('test-relay')){try{const testRelay=new URL(params.get('test-relay'));if(testRelay.protocol==='ws:'&&['127.0.0.1','localhost'].includes(testRelay.hostname)){relays=validateRelays([testRelay.href]);useDiscoveryRelays=false;}}catch{}}
let preferredCurrency=initialCurrency({saved:load('market-currency',null),locales:navigator.languages});
let rateService;
const priceFor=l=>formatPrice(l,{preferredCurrency,rates:rateService?.snapshot()});
const bitcoinQuote = listing => listing.escrow?.trade === 'bitcoin_fiat' ? fiatQuoteLabel(listing.price, listing.currency) : undefined;
function priceNode(listing, className) {
  const quote = bitcoinQuote(listing);
  if (quote) return node('p', quote, className);
  const info = priceFor(listing), price = node('p', undefined, className);
  const detail = className === 'detail-price';
  price.append(node('span', info.primary));
  if (detail && info.original) price.append(node('small', info.original, 'original-price'));
  if (info.source) {
    const when = new Intl.DateTimeFormat(undefined, {dateStyle: info.stale ? 'medium' : undefined, timeStyle: 'short'}).format(info.updatedAt * 1000);
    price.title = `${info.source} · ${info.stale ? 'Last known' : 'Retrieved'} ${when}`;
    if (detail) price.append(node('small', price.title, 'original-price'));
  }
  return price;
}

const bookmark='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.4 5.4 0 0 0-7.6 0L12 5.8l-1.2-1.2a5.4 5.4 0 0 0-7.6 7.6L12 21l8.8-8.8a5.4 5.4 0 0 0 0-7.6Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
const node = domElement;
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,2500);}
function save(l){gridUI.pin();if(saved.has(l.id))saved.delete(l.id);else if(saved.size<1000)saved.add(l.id);else return toast('Saved-listing limit reached');persist('market-saved-'+(preview?'preview':'live'),[...saved]);render();refreshProfileListings();if(focusedListing)openDetail(focusedListing,false);}
function photo(l,className?:string){return createStaticImage(l.imageUrl,{width:className==='detail-art'?900:480,className,alt:l.title||'Listing photo',fallback:art(l)});}
function internalLink(link,href,onClick){link.href=routeHref(href);link.onclick=event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onClick();};}
function card(l){const el=node('article',undefined,'listing-card'),media=node('div',undefined,'card-image'),open=node('a',undefined,'card-open');open.setAttribute('aria-label',`View ${l.title}`);if(l.escrow?.trade==='bitcoin_fiat'&&!l.imageUrl){const quote=node('div',undefined,'bitcoin-card-quote');quote.append(node('strong',l.escrow.sats.toLocaleString()+' sats'),node('span',fiatMethodLabel(l.escrow.method)));open.append(quote);}else open.append(photo(l));internalLink(open,listingURL(l.id,location.href),()=>openDetail(l));const button=node('button',undefined,'save-button');button.innerHTML=bookmark;button.querySelector('path').setAttribute('fill',saved.has(l.id)?'currentColor':'none');button.setAttribute('aria-label',`${saved.has(l.id)?'Unsave':'Save'} ${l.title}`);button.setAttribute('aria-pressed',String(saved.has(l.id)));button.onclick=()=>save(l);media.append(open,button);if(l.escrow?.trade==='bitcoin_fiat')media.append(node('span',l.side==='request'?'Buying bitcoin':'Selling bitcoin','request-badge'));else if(l.side==='request')media.append(node('span','Buying','request-badge'));const title=node('a',l.title,'card-title');internalLink(title,listingURL(l.id,location.href),()=>openDetail(l));const titleRow=node('div',undefined,'card-title-row');titleRow.append(title,listingMenu(l.title,hiddenListings.has(l.id),()=>toggleHidden(l)));el.append(media,titleRow,priceNode(l,'card-price'),node('p',l.location||'Anywhere','card-location'));if(!preview&&l.author)el.append(authorButton(l));return el;}
function authorButton(l){return createUserRow(l.author,{className:'author-button',onClick:()=>profiles.open(l.author)});}
function routeHref(href){const url=new URL(href);const hash=locationHash(locationFilter);if(hash&&['home','search'].includes(parseMarketRoute(url.href).type))url.searchParams.set('g',hash);if(preview)url.searchParams.set('preview','1');if(['127.0.0.1','localhost'].includes(location.hostname)&&params.has('test-relay'))url.searchParams.set('test-relay',params.get('test-relay'));return url.href;}
// Retain one browsing surface across listing and workspace navigation.
let retainedBrowse: {href:string; input:string; scroll:number}|null=null;
function rememberBrowse(){
  if(!['home','search','saved'].includes(currentRoute.type))return;
  gridUI.pin();
  retainedBrowse={href:location.href,input:$('search').value,scroll:window.scrollY};
}
function navigate(href,{activate=true,replace=false}={}){href=routeHref(href);if(location.href===href){if(activate)activateRoute();return;}rememberBrowse();const returning=retainedBrowse?.href===href;history.replaceState({...history.state,marketScroll:window.scrollY},'',location.href);history[replace?'replaceState':'pushState']({marketInternal:true},'',href);currentRoute=parseMarketRoute(href);if(activate)activateRoute(returning);else frameRoute();window.scrollTo(0,returning?retainedBrowse?.scroll||0:0);}
function backToBrowse(){if(history.state?.marketInternal)history.back();else navigate(pageURL('',location.href));}
function frameRoute(){if(currentRoute.type!=='search')bitcoinOrders.stop();placeSearch();aiFilter?.viewChanged();const type=currentRoute.type;document.title=({home:'Iris Market',search:'Search results · Iris Market',saved:'Saved · Iris Market',profile:'Profile · Iris Market',post:'Post a listing · Iris Market',messages:'Messages · Iris Market',orders:'Orders · Iris Market',wallet:'Wallet · Iris Market',settings:'Settings · Iris Market',account:'Profile settings · Iris Market',courier:'Transport · Iris Market'}[type]||'Iris Market');const browsing=type==='home'||type==='search'||type==='saved';const skip=document.querySelector<HTMLAnchorElement>('.skip');skip.textContent='Skip to content';skip.href=browsing?'#main':type==='profile'?'#profile-page':['listing','missing'].includes(type)?'#listing-page':'#workspace-page';$('main').hidden=!browsing;$('listing-page').hidden=!['listing','missing'].includes(type);$('profile-page').hidden=type!=='profile';$('workspace-page').hidden=browsing||['listing','missing','profile'].includes(type);$('preferences-dialog').hidden=type!=='settings';if(type!=='profile')profiles?.close({notify:false});if(type!=='account')accountUI?.hideAccount();if(type!=='messages')accountUI?.hideInbox();if(!['orders','courier'].includes(type))ordersUI?.hide();if(type!=='wallet')walletUI?.hide();if(type!=='post')composerUI?.hide({preservePending:type==='account'});if(type!=='listing'){detailRenderKey='';closeDetailReviews();closeDetailAreas();focusedListing=null;detailClient?.close();detailClient=null;}gridUI.setVisible(browsing&&!$('listings').hidden);for(const [id,active] of [['browse-tab',type==='home'||type==='search'],['saved-tab',type==='saved'],['orders-tab',['orders','courier'].includes(type)],['inbox-tab',type==='messages'],['wallet-tab',type==='wallet']] as const)$(id).classList.toggle('active',active);syncCourierFeed();}
function activateRoute(restoreBrowse=false){if(!routeReady)return;userLocation?.closeChooser();currentRoute=parseMarketRoute(location.href);frameRoute();const route=currentRoute;if(route.type==='home'||route.type==='saved'||route.type==='search'){if(restoreBrowse&&retainedBrowse?.href===location.href){$('search').value=retainedBrowse.input;render();return;}retainedBrowse=null;const switchingSaved=savedOnly!==(route.type==='saved');savedOnly=route.type==='saved';$('main').classList.toggle('saved-view',savedOnly);if(switchingSaved)resetShipping();if(switchingSaved&&(feedTags.length||feedAuthors!==null||nearbyFilter))start();if(route.type==='search'){void aiFilter?.submit(route.query);}else{$('search').value='';submittedTextQuery='';aiFilter?.stop();}render();return;}if(route.type==='listing'){const found=listings.find(l=>l.id===route.id)||focusedListing;if(found?.id===route.id)openDetail(found,false);else{closeDetailReviews();closeDetailAreas();focusedListing=null;$('detail-content').replaceChildren(node('h1','Listing'),node('p','This listing hasn’t arrived yet. You can keep browsing.','muted'));}if(!preview&&client?.targetId!==route.id&&detailClient?.targetId!==route.id){detailClient?.close();detailClient=new MarketRelayClient({relays,authors:[],targetId:route.id,maxRecords:8,onChange:rows=>{if(currentRoute.type==='listing'&&currentRoute.id===route.id){const value=rows.find(l=>l.id===route.id);if(value)openDetail(value,false);else if(detailClient?.records.has(route.id))unavailableListing();}}});detailClient.start();}return;}if(route.type==='profile'){void profiles.open(route.pubkey,{navigate:false});return;}if(route.type==='post'){composerUI.open();return;}if(route.type==='wallet'){void walletUI.open();return;}if(route.type==='messages'){if(route.pubkey)void accountUI.openChat(route.pubkey);else accountUI.showInbox();return;}if(route.type==='account'){accountUI.showAccount();return;}if(route.type==='courier'){ordersUI.open(undefined,'deliveries');return;}if(route.type==='orders'){ordersUI.open(route.id,route.id?undefined:'purchases');return;}if(route.type==='missing')$('detail-content').replaceChildren(node('h1','Page not found'),node('p','Check the link or return to Home.','muted'));}
function pageOpened(href){if(!routeReady)return;navigate(href,{activate:false});}
function unreadNav(id,count){const button=$(id);let dot=button.querySelector('.nav-unread');if(!dot){dot=node('span',undefined,'nav-unread');dot.setAttribute('aria-hidden','true');button.append(dot);}dot.hidden=count===0;if(id==='orders-tab'){dot.classList.add('nav-unread-count');dot.textContent=count>99?'99+':String(count);}button.setAttribute('aria-label',`${id==='inbox-tab'?'Messages':'Orders'}${count?`, ${count} unread`:''}`);}
function render(){client?.setBuying(!savedOnly&&side==='request'&&['home','search'].includes(currentRoute.type),category);void loadShippingDetails();const aiEnabled=!!aiFilter?.enabled(),submitted=aiEnabled?aiFilter.query?.()||'':submittedTextQuery;if(aiEnabled&&submitted)submittedTextQuery=submitted;const aiSelected=aiEnabled&&!aiFilter.showingAll();searchDiscovery.update(submitted,aiSelected?'expanded':'literal');updateFilterSummary();let result=savedOnly?listings.filter(l=>saved.has(l.id)):listings.filter(l=>!hiddenListings.has(l.id)&&(!photosOnly()||!!l.imageUrl||photoFilter===null&&l.escrow?.trade==='bitcoin_fiat')).filter(l=>(feedAuthors===null||feedAuthors.includes(l.author))&&(!feedNetwork||(graphContext?.rankRelationFor(l.author)||graphContext?.relationFor(l.author))?.distance===1)&&(!feedTags.length||feedTags.some(t=>(l.tags||[l.category]).includes(t)))).filter(l=>(side==='all'||l.side===side)&&(category==='all'||(l.category||'').toLowerCase()===category));const query=(aiFilter?.enabled()?aiFilter.query?.()||'':submittedTextQuery).trim().toLowerCase(),place=locationFilter.toLowerCase(),cell=locationHash(place);
const orderQuery=currentRoute.type==='search'&&!preview&&!savedOnly&&!mapVisible&&!place&&!nearbyFilter&&!shipsTo&&category==='all'&&photoFilter!==true&&!feedNetwork&&feedAuthors===null&&!feedTags.length?query:'';
const orderCount=bitcoinOrders.update(orderQuery,side,relays,useDiscoveryRelays);
const literalQuery=aiSelected?'':query;
if(!savedOnly&&(literalQuery||nearbyFilter||place||shipsTo))result=result.filter(l=>
  (!literalQuery||matchesLiteralSearch(listingSearchText(l),literalQuery))
  &&(nearbyFilter?listingMatchesNearby(l,nearbyFilter):cell?mapVisible||l.originalTags?.some(t=>t[0]==='g'&&t.length===2&&decodeGeohash(t[1])?.geohash.startsWith(cell)):(l.location||'').toLowerCase().includes(place))
  &&(!shipsTo||matchesShippingDestination(shippingResolver.forListing(l),shipsTo)));if(!savedOnly&&$('sort').value==='price')result.sort((a,b)=>{const av=priceFor(a).converted,bv=priceFor(b).converted;if(av!==null&&bv!==null)return av-bv;if(av!==null)return -1;if(bv!==null)return 1;return(a.currency||'').localeCompare(b.currency||'')||(a.price===''?Infinity:Number(a.price))-(b.price===''?Infinity:Number(b.price));});if(!savedOnly&&$('sort').value!=='price')result=rankListings(result,{sort:$('sort').value as 'suggested'|'social'|'newest',saved,savedListings:listings,query,aiScoreFor:listing=>aiFilter?.scoreFor(listing),location:nearbyFilter||userLocation?.point(),relationFor:key=>graphContext?.rankRelationFor(key)||graphContext?.relationFor(key)});aiCandidates=savedOnly?[]:result;if(!savedOnly)result=result.filter(l=>!aiFilter||aiFilter.isVisible(l));visibleResult=result;const forYou=!!aiFilter?.homeActive()&&!aiFilter.showingAll();if(['home','search','saved'].includes(currentRoute.type))gridUI.update(result,JSON.stringify([preview,savedOnly,side,category,query,place,nearbyFilter,shipsTo,$('sort').value,feedTags,feedAuthors,feedNetwork,contextKey,aiFilter?.enabled(),forYou,photosOnly()]),forYou&&currentRoute.type==='home'&&$('sort').value==='suggested');mapUI?.refresh();$('saved-count').textContent=String(saved.size);$('page-title').textContent=savedOnly?'Saved listings':query?'Search results':forYou?'For you':'Listings';$('result-count').textContent=[(result.length||!orderCount)?result.length+' '+(result.length===1?'listing':'listings'):'',orderCount?orderCount+' bitcoin '+(orderCount===1?'order':'orders'):''].filter(Boolean).join(' · ');$('empty').hidden=result.length!==0||orderCount>0||!!aiFilter?.searching?.()||shippingBusy;const noBuyRequests=!savedOnly&&side==='request'&&!aiCandidates.length;$('empty-title').textContent=noBuyRequests?'No buy requests found':savedOnly?'No saved listings':aiFilter?.homeActive()?'No matches yet':query||place||shipsTo||category!=='all'||side!=='offer'||feedNetwork||feedTags.length?'No matches':'No listings yet';$('empty-description').textContent=noBuyRequests?(query||category!=='all'||place||shipsTo||feedNetwork||feedTags.length||photoFilter===true?'Try clearing your filters.':'Requests appear here when someone posts what they want to buy.'):savedOnly?'Tap a heart to save a listing.':aiFilter?.homeActive()?'Change your home preferences in Filters, or choose Show all.':query||place||shipsTo||category!=='all'||side!=='offer'||feedNetwork||feedTags.length?'Try another search or clear your filters.':'Refresh to check for new listings.';$('clear-filters').hidden=!(query||place||shipsTo||category!=='all'||side!=='offer'||feedNetwork||feedTags.length);$('browse-tab').classList.toggle('active',currentRoute.type==='home'||currentRoute.type==='search');$('saved-tab').classList.toggle('active',currentRoute.type==='saved');aiFilter?.refresh();}
const escrowTrade=setupEscrowTrade({account:()=>accountUI,wallet:()=>walletUI,isPreview:()=>preview,lookup:async (id,latest)=>{
  const known=client?.records.get(id)??detailClient?.records.get(id)??listings.find(l=>l.id===id);
  if(known&&!latest)return known;
  const parts=id.split(':');const kind=id.startsWith('38383:')?Number(parts.shift()):30402;
  const author=parts.shift(),identifier=parts.join(':');if(![30402,38383].includes(kind)||!/^[0-9a-f]{64}$/.test(author)||!identifier)return;
  const {events}=await getPublicRuntime(relays).query([{kinds:[kind],authors:[author],'#d':[identifier],...(kind===38383?{'#y':['iris-market']}:{})}],{limit:16,deadline:Date.now()+5000,cache:'network-only'});
  let winner=known, observed=false;
  for(const event of events){
    try{
      const listing=parseEvent(event);
      if(listing.id!==id)continue;
      observed=true;
      if(!winner||listing.createdAt>winner.createdAt||listing.createdAt===winner.createdAt&&listing.eventId<winner.eventId)winner=listing;
    }catch{ /* Ignore invalid relay records. */ }
  }
  if(latest&&!observed)throw Error('No relay could confirm this listing. Reconnect and retry.');
  return winner;
}});
function openDetail(l,update=true){if(update){focusedListing=l;navigate(listingURL(l.id,location.href));return;}focusedListing=l;const renderKey=JSON.stringify([l.eventId||l.id,saved.has(l.id),priceFor(l),readImageSettings(),accountUI?.state().ownerPubkey,marketplaceToolEnabled('escrow'),preview]);if(detailRenderKey===renderKey&&$('detail-content').childElementCount)return;detailRenderKey=renderKey;const rawOpen=$('detail-content').querySelector<HTMLDetailsElement>('.listing-raw-event')?.open;const areaKey=l.serviceAreas?JSON.stringify(l.serviceAreas):'';if(areaKey!==detailAreaKey){closeDetailAreas();detailAreaKey=areaKey;if(l.serviceAreas)detailAreaPreview=setupServiceAreaPicker({value:l.serviceAreas,readOnly:true});}const detail=renderListingPage(l,{saved:saved.has(l.id),onSave:save,onBuy:value=>{const enquiry=listingEnquiry(value,location.href);if(value.side==='request'||value.escrow?.trade==='bitcoin_fiat')void accountUI.openChat(value.author,{draft:enquiry.draft,context:listingContext(value.id)});else ordersUI.buy(value);},onProfile:key=>profiles.open(key),priceNode,authorRow:authorButton,isPreview:preview,owner:accountUI?.state().ownerPubkey,onEdit:value=>composerUI.edit?.(value),onCloseBitcoin:marketplaceToolEnabled('escrow')?value=>composerUI.closeBitcoin(value):undefined,onToast:toast});const escrowEntry=escrowTrade.entry(l);if(escrowEntry)detail.querySelector('.detail-actions')?.append(escrowEntry);if(detailAreaPreview){const media=detail.querySelector('.detail-media');if(!l.imageUrl&&media){media.classList.add('detail-area-media');media.replaceChildren(detailAreaPreview.element);}else detail.append(detailAreaPreview.element);}if(!preview){if(detailReviewsKey!==l.id){closeDetailReviews();detailReviewsKey=l.id;detailReviews=setupProductReviews({listing:l,query:(filters,options)=>getPublicRuntime(relays).query(filters,options),onProfile:key=>profiles.open(key)});}detail.append(detailReviews.element);void detailReviews.start();}$('detail-content').replaceChildren(detail);if(rawOpen){const raw=detail.querySelector<HTMLDetailsElement>('.listing-raw-event');if(raw)raw.open=true;}if(detailAreaPreview)void detailAreaPreview.show();document.title=`${l.title} · Iris Market`;}
function start(){searchDiscovery.reset();client?.close();aiFilter?.stop();listings=[];gridUI.reset();$('preview-note').hidden=!preview;$('mode-toggle').textContent=preview?'Live market':'Preview';$('refresh').disabled=preview;render();if(preview){listings=previewListings;$('network-status').textContent='Preview';$('network-status').classList.remove('live');render();showShared();return;}try { client=new MarketRelayClient({relays,mapRelay:useDiscoveryRelays?'wss://relay.ditto.pub':undefined,browseDiscovery:true,tags:savedOnly?[]:feedTags,authors:savedOnly?null:feedAuthors,targetId:currentRoute.type==='listing'?currentRoute.id:undefined,onChange(data){listings=data;render();showShared()},onPagination:()=>render(),onStatus(status){$('network-status').textContent=status.state==='live'?`${status.connected} ${status.connected===1?'relay':'relays'}`:status.state==='offline'?'Relays unavailable':status.message||'Connecting…';$('network-status').classList.toggle('live',status.state==='live')}});client.setBuying(!savedOnly&&side==='request',category);client.start(); if(!savedOnly)client.setGeohashes(feedCells());mapUI?.refreshDiscovery(); } catch(error) { $('network-status').textContent='Connection unavailable'; toast(error.message); }}
function syncCourierFeed(){
  if(!['courier','orders'].includes(currentRoute.type)){courierClient?.close();courierClient=null;courierListings=[];return;}
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
window.addEventListener('market-tools-change',()=>{if(currentRoute.type==='listing'&&focusedListing)openDetail(focusedListing,false);});
function showShared(){if(currentRoute.type!=='listing')return;const id=currentRoute.id;const l=listings.find(l=>l.id===id);if(l)openDetail(l,false);else if(client?.records.has(id)||focusedListing?.expiration!==null&&focusedListing?.expiration<=Date.now()/1000)unavailableListing();}
$('sort').onchange=render;
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-side]'))b.onclick=()=>{side=b.dataset.side;document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b))});render()};
for(const b of document.querySelectorAll<HTMLButtonElement>('[data-category]'))b.onclick=()=>{category=b.dataset.category;document.querySelectorAll<HTMLButtonElement>('[data-category]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b))});render()};
$('browse-tab').onclick=()=>navigate(pageURL('',location.href));$('saved-tab').onclick=()=>navigate(pageURL('saved',location.href));$('clear-filters').onclick=()=>{photoFilter=null;feedNetwork=false;feedTags=[];feedAuthors=null;locationFilter='';nearbyFilter=null;shipsTo='';syncAreaURL();resetShipping();updateFilterSummary();start();$('search').value='';submittedTextQuery='';$('location').value='';document.querySelector<HTMLButtonElement>('[data-side="offer"]').click();document.querySelector<HTMLButtonElement>('[data-category="all"]').click()};
$('mode-toggle').onclick=()=>{const u=new URL(location.href);u.searchParams.delete('listing');if(preview)u.searchParams.delete('preview');else u.searchParams.set('preview','1');location.assign(u)};
$('refresh').onclick=()=>{resetShipping();shippingResolver.invalidate();gridUI.reset();client?.refresh();render()};
for(const d of document.querySelectorAll('dialog')){d.querySelector<HTMLButtonElement>('.dialog-close').onclick=()=>d.close();dismissOnBackdrop(d);}
$('listing-back').onclick=event=>{event.preventDefault();backToBrowse();};
$('workspace-page').append($('preferences-dialog'));$('preferences-dialog').querySelector<HTMLButtonElement>('.dialog-close').onclick=backToBrowse;
$('relay-settings').onclick=()=>{$('relay-input').value=relays.join('\n');$('relay-error').textContent='';$('relays-dialog').showModal()};
$('relay-form').onsubmit=e=>{e.preventDefault();const values=[...new Set($('relay-input').value.split('\n').map(x=>x.trim()).filter(Boolean))];if(!values.length||values.length>8)return $('relay-error').textContent='Choose between one and eight relays.';try{for(const raw of values){const u=new URL(raw);if(u.protocol!=='wss:'||u.username||u.password||u.hash||u.search)throw Error()}}catch{return $('relay-error').textContent='Use wss:// relay addresses without credentials.'}relays=values;useDiscoveryRelays=false;resetShipping();shippingResolver=createShippingResolver({query:(filters,options)=>getPublicRuntime(relays).query(filters,options)});resetPeople();persist('market-relays',relays);$('relays-dialog').close();start();loadGraph();void rateService?.refresh();if(accountUI.state().status==='ready')void accountUI.messaging.reconnect().catch(error=>toast(error.message));};
document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!$('main').hidden&&!document.querySelector('dialog[open]')){e.preventDefault();$('search').focus()}});
function networkFilterLabel(){return accountUI?.state().ownerPubkey===contextKey?'People I follow':contextKey===DEFAULT_SOCIAL_GRAPH_ROOT?'Sirius Business’s network':nameFor(contextKey)+'’s network';}
const syncHomePrompt=()=>{$('home-prompt-fields').hidden=!$('home-feed-enabled').checked;};
$('home-feed-enabled').onchange=syncHomePrompt;
$('feed-filters').onclick=()=>{const home=aiFilter.homeFeed();$('home-feed-enabled').checked=home.enabled;syncHomePrompt();$('home-feed-prompt').value=home.prompt;$('has-photos').checked=photosOnly();$('location').value=locationFilter;locationInputs.restore(nearbyFilter);$('ships-to').value=shipsTo;$('tag-input').value=feedTags.join(', ');$('audience').value=feedNetwork?'following':'all';$('audience').querySelector('option[value="following"]').textContent=networkFilterLabel();$('filter-error').textContent='';$('filters-dialog').showModal();updateFilterSummary()};
function feedCells(mapCells:string[]=[]){const hash=locationHash(locationFilter);return mapCells.length?mapCells:hash?[hash]:nearbyFilter?geohashQueryForViewport(nearbyViewport(nearbyFilter)):[];}
function syncAreaURL(){if(!['home','search'].includes(currentRoute.type))return;const url=new URL(location.href),hash=locationHash(locationFilter);if(hash)url.searchParams.set('g',hash);else url.searchParams.delete('g');if(url.href!==location.href)history.replaceState(history.state,'',url);}
function updateFilterSummary(){
  const count=[photosOnly(),shipsTo,locationFilter,feedTags.length,feedNetwork].filter(Boolean).length;
  const label=count ? `Filters (${count})` : 'Filters';
  if($('feed-filters').textContent!==label)$('feed-filters').textContent=label;
  if(!$('filters-dialog').open)return;
  const labels=!preview&&currentRoute.type==='search'&&aiFilter?.enabled()&&!aiFilter.showingAll()&&
    client?.queryExpansion==='expanded'&&client.queryText===aiFilter.query()
    ? relatedSearchLabels(client.queryText,client.queryTags,client.queryExtraTerms) : [];
  const list=$('search-expansion-terms');
  if(labels.length!==list.children.length||labels.some((term,i)=>list.children[i].textContent!==term))
    list.replaceChildren(...labels.map(term=>node('li',term)));
  $('search-expansions').hidden=!labels.length;
}
$('reset-feed-filters').onclick=()=>{photoFilter=null;feedTags=[];feedAuthors=null;feedNetwork=false;locationFilter='';nearbyFilter=null;shipsTo='';syncAreaURL();resetShipping();$('filters-dialog').close();updateFilterSummary();start()};
$('filter-form').onsubmit=e=>{
  e.preventDefault();
  const tags=[...new Set($('tag-input').value.split(',').map(t=>t.trim().replace(/^#/, '')).filter(Boolean))];
  if(tags.length>8||tags.some(t=>t.length>60))return $('filter-error').textContent='Use up to eight tags, each under 60 characters.';
  const oldHome=aiFilter.homeFeed();
  try{
    const home=saveHomeFeed(localStorage,{enabled:$('home-feed-enabled').checked,prompt:$('home-feed-prompt').value});
    if(home.enabled!==oldHome.enabled||home.prompt!==oldHome.prompt)aiFilter.setHomeFeed(home);
  }catch{return $('filter-error').textContent='Could not save home-feed preferences.';}
  const sourceChanged=JSON.stringify(tags)!==JSON.stringify(feedTags)||feedAuthors!==null;
  const previousNearby=JSON.stringify(nearbyFilter),previousHash=locationHash(locationFilter);
  if($('has-photos').checked!==photosOnly())photoFilter=$('has-photos').checked;
  nearbyFilter=locationInputs.pending();locationFilter=nearbyFilter?NEARBY_LABEL:$('location').value.trim();
  shipsTo=$('ships-to').value;syncAreaURL();resetShipping();feedTags=tags;feedNetwork=$('audience').value==='following';feedAuthors=null;
  $('filters-dialog').close();updateFilterSummary();
  if(sourceChanged){
    const query=currentRoute.type==='search'?currentRoute.query:'';
    start();
    if(query)void aiFilter.submit(query);
  }else{
    if(!preview&&(previousNearby!==JSON.stringify(nearbyFilter)||previousHash!==locationHash(locationFilter)))client?.setGeohashes(feedCells());
    render();
  }
};
async function loadGraph(){
  graphAbort?.abort();graphContext=null;graphAbort=new AbortController();
  $('graph-context').textContent=contextKey===DEFAULT_SOCIAL_GRAPH_ROOT?'Sirius Business network':nameFor(contextKey)+' network';
  if(preview){$('curation-status').textContent='Preview · social data stays offline';return;}
  $('curation-status').textContent='Loading public connections…';
  const active=graphAbort;
  try{const result=await loadCurationContext({relays,contextPubkey:contextKey,targetAuthors:listings.map(item=>item.author),signal:active.signal});if(active!==graphAbort)return;graphContext=result;rootChoice.observe(result);if(result.contextPubkey!==contextKey)return;$('curation-status').textContent=result.coverage.rootLoaded?`${result.coverage.directFollows} follows · ${result.coverage.bootstrap?'snapshot + live updates':'partial network'}`:'Connections unavailable';render();}catch(error){if(error.name!=='AbortError')$('curation-status').textContent='Connections unavailable';}
}
const curatedGrid=()=>aiFilter?.enabled()&&(aiFilter.query()||aiFilter.homeActive())&&!aiFilter.showingAll();
const gridUI=setupListingGrid({grid:$('listings'),controls:$('grid-pagination'),button:$('load-more'),status:$('grid-progress'),makeCard:card,
  cardKey:l=>JSON.stringify([l.eventId||l.id,priceFor(l).primary,saved.has(l.id),hiddenListings.has(l.id),graphContext?.relationFor(l.author),readImageSettings()]),
  olderState:()=>{const remote=preview||savedOnly?{hasMore:false}:client?.pagination?.()||{hasMore:false};return curatedGrid()?aiFilter.pagination(remote.hasMore):remote;},
  loadOlder:async()=>{try{if(curatedGrid()){await aiFilter.loadMore();}else await client?.loadOlder?.();}catch{}render()}});
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
accountUI=setupAccount({getMatchListings:()=>preview?[]:listings,renderEscrowTrades:(host,peer,listing)=>escrowTrade.inbox(host,peer,listing),listingTitle:coordinate=>listings.find(item=>item.id===coordinate.replace(/^30402:/,''))?.title,accountPage:$('workspace-page'),onAccountPage:()=>pageOpened(pageURL('settings/profile',location.href)),onAccountClose:backToBrowse,messagePage:$('workspace-page'),onMessagePage:key=>pageOpened(pageURL('messages'+(key?'/'+npubEncode(key):''),location.href)),onMessageClose:backToBrowse,onUnread:count=>unreadNav('inbox-tab',count),getRelays:()=>relays,isPreview:()=>preview,onProfile:key=>profiles.open(key),onOrder:id=>ordersUI?.open(id),onToken:token=>walletUI?.openToken(token),onIdentity:(key,status,previous,pending)=>{$('my-listings-menu').hidden=!key||preview;rootChoice.setIdentity(key||null,previous);if(client){let changed=false;for(const event of pending)try{changed=applyEvent(client.records,event)||changed}catch{}if(changed)client.emitChange();refreshPeople();}}});
accountUI.onState(()=>profiles?.refreshReviews());
composerUI=setupComposer({priceNode,page:$('workspace-page'),onNavigate:()=>pageOpened(pageURL('post',location.href)),onClose:backToBrowse,account:accountUI,isPreview:()=>preview,defaultCurrency:()=>preferredCurrency,onPublished:(event,receipt)=>{if(client){client.acceptListing(client.parseIncoming(event),true);client.emitChange();}toast(receipt?.accepted?.length?'Listing published':'Listing queued');}});
ordersUI=setupOrders({onPay:order=>walletUI.payOrder(order,token=>accountUI.messaging.send(order.seller,token,orderContext(order.id)),()=>ordersUI.open(order.id)),onReceiveToken:(token,id)=>walletUI.openToken(token,()=>ordersUI.open(id)),page:$('workspace-page'),onNavigate:(id,tab)=>pageOpened(pageURL(id?'orders/'+encodeURIComponent(id):tab==='deliveries'?'courier':'orders',location.href)),onClose:backToBrowse,onUnread:count=>unreadNav('orders-tab',count),account:accountUI,isPreview:()=>preview,onProfile:key=>profiles.open(key),onReview:key=>profiles.openReviews(key),courier:{getListings:()=>courierListings,onListing:openDetail,onAnnounce:draft=>composerUI.prefill(draft),onEditListing:listing=>composerUI.edit(listing),renderListing:courierCard,loadMore:async()=>{const active=courierClient;if(!active)return;const page=await active.loadOlder();if(page.error)throw new Error(page.error);},pagination:()=>courierClient?.pagination()||{}},formatPrice:item=>priceFor(item).primary});
$('orders-tab').onclick=()=>navigate(pageURL('orders',location.href));$('post-button').onclick=()=>navigate(pageURL('post',location.href));$('inbox-tab').onclick=()=>navigate(pageURL('messages',location.href));
walletUI=setupWallet({page:$('workspace-page'),onNavigate:()=>pageOpened(pageURL('wallet',location.href)),onClose:backToBrowse,isPreview:()=>preview,onShareMessage:text=>accountUI.composeMessage(text),formatEstimate:amount=>formatWalletAmount(amount,{preferredCurrency,rates:rateService?.snapshot()})});
$('my-listings-menu').onclick=()=>{const owner=accountUI.state().ownerPubkey;if(owner)profiles.open(owner);};
$('courier-menu').onclick=()=>navigate(pageURL('courier',location.href));$('manage-profile').onclick=()=>navigate(pageURL('settings/profile',location.href));$('wallet-tab').onclick=()=>navigate(pageURL('wallet',location.href));$('appearance-settings').onclick=()=>navigate(pageURL('settings',location.href));
mapUI=setupMap({getListings:()=>visibleResult,getPriceLabel:l=>l.price == null || l.price === '' ? undefined : bitcoinQuote(l) ?? priceFor(l).primary,onSelect:openDetail,onVisibilityChange:visible=>{mapVisible=visible;aiFilter?.viewChanged();gridUI.setVisible(!visible&&['home','search','saved'].includes(currentRoute.type));render();},onDiscover:(cells,observed)=>{if(!preview)client?.setGeohashes(savedOnly?[]:feedCells(cells),savedOnly?[]:observed)},isDiscoveryLimited:()=>!preview&&!!client?.mapDiscoveryLimited});
const currencySelectors = [$('preferred-currency'), $('menu-currency')] as HTMLSelectElement[];
for (const selector of currencySelectors) {
  for (const currency of CURRENCIES) {
    const option = node('option', currency === 'SATS' ? 'Satoshis' : currency);
    option.value = currency;
    selector.append(option);
  }
  selector.value = preferredCurrency;
  selector.onchange = () => {
    preferredCurrency = selector.value;
    for (const other of currencySelectors) other.value = preferredCurrency;
    persist('market-currency', preferredCurrency);
    render();
    walletUI?.refresh();
    ordersUI?.refresh(accountUI.state());
    if (focusedListing) openDetail(focusedListing, false);
  };
}
if(!preview)rateService=setupRates({getRelays:()=>relays,onChange:()=>{render();walletUI?.refreshDisplay();if(focusedListing)openDetail(focusedListing,false)}});
window.addEventListener('online',()=>{void rateService?.refresh()});
history.scrollRestoration='manual';
window.addEventListener('popstate',()=>{
  const fromWorkspace=!['home','search','saved'].includes(currentRoute.type);
  if(['home','search'].includes(parseMarketRoute(location.href).type)){
    const cell=decodeGeohash(new URL(location.href).searchParams.get('g'));
    if(cell||locationHash(locationFilter)){
      locationFilter=cell?'#'+cell.geohash:'';nearbyFilter=null;
      if(!preview)client?.setGeohashes(feedCells());
      updateFilterSummary();
    }
  }
  activateRoute(fromWorkspace);
  window.scrollTo(0,history.state?.marketScroll||0);
});
userLocation=setupUserLocation({onChange:render,isPreview:preview});$('your-location-filters').append(userLocation.createControl());$('your-location-settings').append(userLocation.createControl());
window.addEventListener('pagehide',()=>{userLocation?.dispose();searchDiscovery.dispose();closeDetailReviews();closeDetailAreas();client?.close();detailClient?.close();courierClient?.close();profiles?.close({notify:false});graphAbort?.abort();rateService?.close();gridUI.dispose()});aiFilter=setupAI({homeFeed:loadHomeFeed(localStorage),isHomeVisible:()=>currentRoute.type==='home'&&!mapVisible&&!document.hidden,onSubmit:query=>{savedOnly=false;navigate(searchURL(query,location.href),{activate:false});},autoPrepare:!preview,getCandidates:()=>aiCandidates,onChange:render,onTextSearch:query=>{submittedTextQuery=query;},fetchMoreCandidates:async()=>{
  if(preview||savedOnly||!client)return false;
  const active=client;active.openSearchPage();
  const queryPage=active.queryPagination();
  // Ordinary inventory progresses even when optional ranked-search sources are silent.
  const ordinary=active.pagination().hasMore?active.loadOlder():null;
  if(queryPage.loading||queryPage.hasMore){
    const targeted=await active.loadQueryCandidates();
    if(active!==client)return false;
    if(targeted.added>0||targeted.hasMore&&!targeted.error)return true;
  }
  if(!ordinary&&!active.pagination().hasMore)return false;
  const page=await (ordinary||active.loadOlder());
  if(active!==client)return false;
  if(page.added>0)return true;
  if(page.error)throw new Error('Could not fetch older listings.');
  return page.hasMore;
}});routeReady=true;start();activateRoute();loadGraph();
