import { setLoadingStatus } from './loading-status.ts';
import { element as domElement } from './dom.ts';
import {translatedParagraph} from './translation-content.ts';
import { npubEncode } from 'nostr-tools/nip19'
import { loadProfile, loadProfileFollowers, excludeKnownFollowers, readProfileMetadata, subscribeProfileMetadata, DEFAULT_SOCIAL_GRAPH_ROOT, DEFAULT_SOCIAL_GRAPH_LABEL } from './profiles.ts'
import { normalizePublicKey } from './social.ts'
import { createAvatar, createUserRow, warmProfiles } from './people.ts'
import { profileURL } from './routes.ts'
import { setupProfileReviews } from './reviews-ui.ts'
import type { PublishReview, ReviewAccount, ReviewQuery } from './reviews.ts'
import type { PublicProfile, SocialConnection } from './profiles.ts'

const element = domElement

/** Keep signed graph observations first; relay omissions do not remove them. */
export function knownFirstFollowers<T extends {pubkey:string}>(known:readonly T[]=[],observed:readonly T[]=[]):T[] {
  const seen=new Set<string>();return [...known,...observed].filter(person=>{if(seen.has(person.pubkey))return false;seen.add(person.pubkey);return true;});
}

/** Relationship evidence, not an identity or seller-verification mark. */
export function createRelationshipBadge(relation) {
  if (!relation?.badge || relation.distance === null) return null
  const badge = element('span', '✓', `relationship-badge relationship-${relation.badge}`)
  const label = `${relation.description} · ${relation.distance} ${relation.distance === 1 ? 'step' : 'steps'} from the network root. Based on loaded public follow lists.`
  badge.title = label
  badge.setAttribute('aria-label', label)
  badge.setAttribute('role', 'img')
  return badge
}

interface ProfileOptions {
  page?:HTMLElement;getRelays:()=>string[];getContext?:()=>string;isPreview?:()=>boolean;
  onContextChange?:(key:string)=>void;onAuthorListings?:(key:string)=>void;onMessage?:(key:string)=>void;
  onNavigate?:(key:string)=>void;onClose?:()=>void;renderListings?:(key:string,host:HTMLElement)=>void|(()=>void);
  renderCollections?:(key:string,host:HTMLElement)=>()=>void;
  queryReviews?:ReviewQuery;getReviewAccount?:()=>ReviewAccount;publishReview?:PublishReview;onReviewSignIn?:()=>void;
  loadFollowers?:typeof loadProfileFollowers;loadProfileData?:typeof loadProfile;
}
export function setupProfiles({ page, getRelays, getContext = () => DEFAULT_SOCIAL_GRAPH_ROOT, isPreview = () => false, onContextChange = () => {}, onAuthorListings = () => {}, onMessage = () => {}, onNavigate = () => {}, onClose = () => {}, renderListings, renderCollections, queryReviews, getReviewAccount, publishReview, onReviewSignIn, loadFollowers=loadProfileFollowers,loadProfileData=loadProfile }: ProfileOptions) {
  const container = page ?? element('section', undefined, 'profile-page')
  container.setAttribute('aria-labelledby', 'public-profile-title')
  container.hidden = true
  const back = element('button', '←', 'button quiet profile-back')
  back.title = 'Back'
  back.setAttribute('aria-label', 'Back from profile')
  back.onclick = () => close({notify:true})
  const body = element('div', undefined, 'profile-content')
  const identityHost = element('div', undefined, 'profile-heading')
  const status = element('p', '', 'profile-status muted')
  status.setAttribute('role', 'status')
  container.replaceChildren(body, status)
  if (!page) document.body.append(container)
  let controller:AbortController|undefined, generation = 0, currentKey:string|undefined, destroyed = false
  let unsubscribeMetadata:(()=>void)|undefined,followersController:AbortController|undefined,followersGeneration=0,followersLoading=false,followersError=''
  let followers:Awaited<ReturnType<typeof loadProfileFollowers>>|undefined,followersTab:HTMLButtonElement|undefined
  let listingCleanup:(()=>void)|undefined, listingsActive=false, selectedView='listings'
  let reviews:ReturnType<typeof setupProfileReviews>|undefined, reviewSummaryButton:HTMLButtonElement|undefined, reviewTab:HTMLButtonElement|undefined
  const listingHost=element('div',undefined,'profile-listings')
  const collectionHost=element('div',undefined,'profile-collections')
  let stopCollections:(()=>void)|undefined
  const closeCollections=()=>{stopCollections?.();stopCollections=undefined}
  const panel=element('div',undefined,'profile-list-panel')
  panel.id='profile-list-panel';panel.setAttribute('role','tabpanel')
  const stopListings=()=>{listingCleanup?.();listingCleanup=undefined;listingsActive=false}
  type ProfileData=Awaited<ReturnType<typeof loadProfile>>
  let currentData:ProfileData|undefined,followDistanceNote:HTMLElement|undefined
  let bio:{owner:string;text:string;node:HTMLElement}|undefined
  type ProfileView={id:string;label:string;people?:{pubkey:string}[];empty?:string;note?:string}
  const connectionViews=(data?:ProfileData):ProfileView[]=>[
    {id:'following',label:data?`Following ${data.following.total ?? '—'}`:'Following',people:data?.following.items,empty:data?.following.total===null?'Follow list unavailable.':'This public list is empty.',note:data?.following.truncated?`Showing the first ${data.following.items.length} of ${data.following.total} follows.`:'Latest signed follow list observed on your servers.'},
    {id:'followers',label:followerLabel(),people:followerPeople(),empty:'No followers found.',note:'Observed followers only. Servers can omit records; this is not a total follower count.'},
  ]
  const stopFollowers=()=>{followersController?.abort();followersController=undefined;followersGeneration++;followersLoading=false}
  const knownPeople=()=>{const excluded=new Set(followers?.excludedKnownFollowers??[]);return (currentData?.followedByKnown??[]).filter(person=>!excluded.has(person.pubkey));};
  const followerPeople=()=>knownFirstFollowers(knownPeople(),followers?.items);
  const openFollowersTab=()=>{followersTab?.click();followersTab?.focus();};
  const followerLabel=()=>followers||followerPeople().length?`Followers ${followerPeople().length}`:'Followers';
  const renderFollowers=()=>{
    if(followersTab)followersTab.textContent=followerLabel();
    if(selectedView!=='followers')return;
    const people=followerPeople();
    panel.replaceChildren(peopleList(people,followers?'No followers found.':''));
    if(followers)return;
    const note=element('p',followersError||'Loading followers…',followersError?'muted small':'muted small loading-state');note.setAttribute('role','status');panel.append(note);
    if(followersError){const retry=element('button','Try again','text-button');retry.onclick=()=>void requestFollowers();panel.append(retry);}
  }
  const requestFollowers=async()=>{
    if(followers||followersLoading||!currentKey||isPreview())return
    const owner=currentKey,run=generation,request=++followersGeneration,abort=new AbortController();followersController=abort;followersLoading=true;followersError='';renderFollowers()
    try{const value=await loadFollowers(owner,{relays:getRelays(),signal:abort.signal});if(run!==generation||request!==followersGeneration||abort.signal.aborted||destroyed)return;followers=value;if(currentData){currentData={...currentData,relation:excludeKnownFollowers(currentData.relation,value.excludedKnownFollowers)};if(followDistanceNote){followDistanceNote.hidden=currentData.relation.distance===null;followDistanceNote.textContent=currentData.relation.distance===null?'':`Follow distance: ${currentData.relation.distance}`;}}}
    catch(error){if(run!==generation||request!==followersGeneration||abort.signal.aborted||destroyed)return;followersError='Could not load followers.'}
    finally{if(run===generation&&request===followersGeneration&&!destroyed){followersLoading=false;followersController=undefined;identityHost.replaceChildren();renderIdentity(currentData?.profile??readProfileMetadata(owner,{relays:getRelays()}),currentData?.relation);renderFollowers()}}
  }
  const renderSections=(data?:ProfileData)=>{
    const tabs=element('div',undefined,'profile-tabs')
    tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Profile')
    const views:ProfileView[]=[{id:'listings',label:'Listings'},...(renderCollections?[{id:'collections',label:'Collections'}]:[]),{id:'reviews',label:'Reviews'},...connectionViews(data)]
    const select=(view:ProfileView,button:HTMLButtonElement)=>{
      selectedView=view.id
      if(view.id!=='collections')closeCollections()
      for(const tab of tabs.children){tab.setAttribute('aria-selected',String(tab===button));(tab as HTMLElement).tabIndex=tab===button?0:-1}
      panel.setAttribute('aria-labelledby',button.id)
      if(view.id==='listings'){
        panel.replaceChildren(listingHost)
        if(!listingsActive){
          listingsActive=true;listingHost.replaceChildren()
          if(renderListings){const cleanup=renderListings(currentKey,listingHost);if(typeof cleanup==='function')listingCleanup=cleanup}
          else {const browse=element('button','Browse listings','button secondary');browse.onclick=()=>{const key=currentKey;close();onAuthorListings(key)};listingHost.append(browse)}
        }
      }else if(view.id==='collections'){
        stopListings()
        panel.replaceChildren(collectionHost)
        if(!stopCollections)stopCollections=renderCollections(currentKey,collectionHost)
      }else if(view.id==='reviews'){
        stopListings()
        panel.replaceChildren(reviews.element)
      }else{
        stopListings()
        if(view.id==='followers')renderFollowers()
        else panel.replaceChildren(view.people?peopleList(view.people,view.empty):element('p','Loading connections…','muted small loading-state'))
      }
    }
    for(const view of views){
      const tab=element('button',view.label);tab.id=`profile-tab-${view.id}`;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',panel.id)
      tab.onclick=()=>{select(view,tab);if(view.id==='followers'&&!followersError)void requestFollowers()}
      if(view.id==='reviews')reviewTab=tab
      if(view.id==='followers')followersTab=tab
      tab.onkeydown=event=>{
        if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return
        event.preventDefault();const current=[...tabs.children].indexOf(tab),total=views.length
        const index=event.key==='Home'?0:event.key==='End'?total-1:(current+(event.key==='ArrowRight'?1:-1)+total)%total
        ;(tabs.children[index] as HTMLButtonElement).click();(tabs.children[index] as HTMLButtonElement).focus()
      }
      tabs.append(tab)
    }
    body.append(tabs,panel)
    const selected=views.findIndex(view=>view.id===selectedView)
    select(views[selected],tabs.children[selected] as HTMLButtonElement)
  }

  function close({notify=false}: {notify?:boolean} = {}) {
    controller?.abort();unsubscribeMetadata?.();unsubscribeMetadata=undefined;stopFollowers();followers=undefined;followersTab=undefined;currentData=undefined;followDistanceNote=undefined;closeCollections();stopListings(); reviews?.close(); reviews=undefined; reviewTab=undefined; reviewSummaryButton=undefined; generation++; currentKey=undefined; container.hidden=true
    if (notify && !destroyed) onClose()
  }
  const peopleList = (people, emptyText) => {
    const list = element('div', undefined, 'profile-people')
    if (!people.length) { list.append(element('p', emptyText, 'muted small')); return list }
    for (const person of people) {
      const button = createUserRow(person.pubkey, { size:34, className:'profile-person', href:profileURL(person.pubkey,location.href),onClick:() => open(person.pubkey) })
      list.append(button)
    }
    return list
  }
  const renderIdentity = (profile:PublicProfile, relation?:SocialConnection) => {
    const identity = element('div', undefined, 'profile-identity')
    const name = element('h1', profile.name)
    name.id = 'public-profile-title'
    const badge = createRelationshipBadge(relation)
    if (badge) name.prepend(badge)
    const heading = element('div')
    heading.append(name)
    reviewSummaryButton=element('button',reviews?.summary().label??'Reviews','text-button profile-review-summary')
    reviewSummaryButton.onclick=()=>reviewTab?.click()
    heading.append(reviewSummaryButton)
    identity.append(back, createAvatar(profile.pubkey, {size:76}), heading)
    identityHost.append(identity)
    const observed=followerPeople();
    if(observed.length){
      const row=element('div',undefined,'profile-followed-by');row.setAttribute('aria-label','Followers from observed public follow lists');
      const label=element('button','Followed by','text-button');label.type='button';label.onclick=openFollowersTab;row.append(label);
      for(const [index,person] of observed.slice(0,3).entries()){
        if(index)row.append(element('span',',','profile-followed-separator'));
        row.append(createUserRow(person.pubkey,{size:20,className:'profile-followed-person',href:profileURL(person.pubkey,location.href),onClick:()=>void open(person.pubkey)}));
      }
      if(observed.length>3){const others=element('button',`and ${observed.length-3} ${observed.length===4?'other':'others'}`,'text-button');others.type='button';others.onclick=openFollowersTab;row.append(others);}
      identityHost.append(row);
    }
    if (profile.about) {
      if(bio?.owner!==profile.pubkey || bio.text!==profile.about)
        bio={owner:profile.pubkey,text:profile.about,node:translatedParagraph(profile.about,'profile-about')}
      identityHost.append(bio.node)
    }else bio=undefined
    if (profile.website) {
      const link = element('a', new URL(profile.website).hostname, 'profile-website')
      link.href = profile.website; link.target = '_blank'; link.rel = 'noopener noreferrer'
      identityHost.append(link)
    }
    if (profile.nip05) identityHost.append(element('p', `${profile.nip05} · Self-declared address`, 'profile-address muted small'))
  }
  const renderActions = (profile:PublicProfile) => {
    const actions = element('div', undefined, 'profile-actions')
    const share = element('button', 'Copy profile link', 'text-button')
    share.onclick = async () => {
      try { await navigator.clipboard.writeText(profileURL(profile.pubkey, location.href)); setLoadingStatus(status, 'Profile link copied')}
      catch { setLoadingStatus(status, 'Copy the address from your browser.')}
    }
    const message = element('button', 'Message', 'button primary'); message.onclick = () => { close(); onMessage(profile.pubkey) };
    actions.append(message, share); body.append(actions)

  }
  const renderCached = (key:string) => {
    const profile=readProfileMetadata(key,{relays:getRelays()})
    body.replaceChildren(identityHost);identityHost.replaceChildren();renderIdentity(profile); renderActions(profile); renderSections()
    return profile.eventId
  }
  const render = data => {
    const profile = data.profile
    body.replaceChildren(identityHost);identityHost.replaceChildren();renderIdentity(profile,data.relation)
    const connection = element('div', undefined, 'profile-connection')
    const connectionText = data.relation.distance === 1 ? `Followed by ${data.contextLabel}` : ''
    if(connectionText) connection.append(element('p',connectionText))
    if (data.mutualFollowing) connection.append(element('p', `Mutual follows with ${data.contextLabel}`, 'small'))
    else if (data.followsContext) connection.append(element('p', `Follows ${data.contextLabel}`, 'small'))
    if(connection.children.length) body.append(connection)

    renderActions(profile)

    renderSections(data)
    const views=connectionViews(data)

    const network = element('details', undefined, 'profile-network')
    network.append(element('summary', 'Network details'))
    network.append(element('p',`Connections through ${data.contextLabel}.`,'small muted'))
    followDistanceNote=element('p',data.relation.distance===null?'':`Follow distance: ${data.relation.distance}`,'small muted');followDistanceNote.hidden=data.relation.distance===null;network.append(followDistanceNote)
    network.append(element('p',`Known followers are people ${data.contextLabel} follows, from loaded public follow lists. Only ${data.coverage.secondHopLoaded} of ${data.coverage.directFollows??'?'} follow lists were loaded.`,'small muted'))
    for(const view of views)network.append(element('p',view.note,'small muted'))
    for(const warning of new Set(data.coverage.warnings))network.append(element('p',String(warning),'small muted'))
    const copy=element('button','Copy user ID','text-button');copy.onclick=async()=>{try{await navigator.clipboard.writeText(npubEncode(profile.pubkey));setLoadingStatus(status, 'User ID copied')}catch{setLoadingStatus(status, 'Could not copy this user ID.')}};network.append(copy)
    const form = element('form')
    const label = element('label', 'Public profile for connections'); label.htmlFor = 'profile-context'
    const input = element('input'); input.id = 'profile-context'; input.placeholder = 'Public user ID'; input.autocomplete = 'off'; input.spellcheck = false
    input.value = npubEncode(data.contextPubkey)
    const error = element('p', '', 'error small'); error.setAttribute('role', 'alert')
    const apply = element('button', 'Use profile', 'button secondary'); apply.type = 'submit'
    const reset = element('button', `Use ${DEFAULT_SOCIAL_GRAPH_LABEL}`, 'text-button'); reset.type = 'button'
    const update = async key => {
      try { await onContextChange(key); open(currentKey,{navigate:false}) } catch { error.textContent = 'Could not change the network profile.' }
    }
    form.onsubmit = event => { event.preventDefault(); try { update(normalizePublicKey(input.value)) } catch (cause) { error.textContent = cause.message } }
    reset.onclick = () => update(DEFAULT_SOCIAL_GRAPH_ROOT)
    form.append(label, input, error, apply, reset)
    network.append(form, element('p', 'Uses public follow lists. This does not sign in or follow anyone.', 'small muted'))
    body.append(network)
    setLoadingStatus(status, '')
  }

  async function open(pubkey:string, {navigate=true}: {navigate?:boolean} = {}) {
    if (destroyed) return
    let key:string
    try { key = normalizePublicKey(pubkey) } catch (error) { setLoadingStatus(status, error.message); return }
    const beforeNavigate=generation
    if (navigate) onNavigate(key)
    // A router may synchronously reopen this profile without navigation.
    if (generation!==beforeNavigate || destroyed) return
    controller?.abort();unsubscribeMetadata?.();unsubscribeMetadata=undefined;stopFollowers();followers=undefined;followersError='';followersTab=undefined;currentData=undefined;followDistanceNote=undefined;closeCollections();stopListings(); reviews?.close(); reviewTab=undefined; reviewSummaryButton=undefined; selectedView='listings'; controller = new AbortController(); const run = ++generation
    currentKey = key; container.hidden=false; container.scrollTop=0
    reviews=setupProfileReviews({target:key,query:queryReviews,getAccount:getReviewAccount,publish:publishReview,preview:isPreview(),onSignIn:onReviewSignIn,onProfile:pubkey=>void open(pubkey),onSummary:value=>{if(run===generation&&reviewSummaryButton)reviewSummaryButton.textContent=value.label}})
    const displayed=renderCached(key)
    if (isPreview()) { setLoadingStatus(status, 'Profiles are available in live mode.'); return }
    // The header is not a user row, so nothing else keeps a live lookup open for it.
    warmProfiles([key])
    void requestFollowers()
    setLoadingStatus(status, displayed ? 'Loading connections…' : 'Loading profile…', true)
    // Metadata is useful immediately, even while graph discovery is pending.
    // Updating only the identity keeps listing cards and active forms mounted.
    unsubscribeMetadata=subscribeProfileMetadata(profile=>{
      if(run!==generation||destroyed||profile.pubkey!==currentKey)return
      if(currentData)currentData={...currentData,profile}
      identityHost.replaceChildren();renderIdentity(profile,currentData?.relation)
    },{relays:getRelays()})
    try {
      const data = await loadProfileData(key, { relays: getRelays(), contextPubkey: getContext() || DEFAULT_SOCIAL_GRAPH_ROOT, signal: controller.signal })
      if (run !== generation || destroyed) return
      currentData={...data,profile:readProfileMetadata(key,{relays:getRelays()}),relation:excludeKnownFollowers(data.relation,followers?.excludedKnownFollowers)};render(currentData)
    } catch (error) { if (run === generation && error.name !== 'AbortError') setLoadingStatus(status, error.message || 'Could not load this profile.')}
  }
  return { open, openReviews(pubkey:string){void open(pubkey);reviewTab?.click()}, close, refreshReviews(){reviews?.refresh()}, destroy() { destroyed = true; close(); container.replaceChildren(); if(!page)container.remove() } }
}
