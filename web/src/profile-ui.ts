import { element as domElement } from './dom.ts';
import { npubEncode } from 'nostr-tools/nip19'
import { loadProfile, readProfileMetadata, DEFAULT_SOCIAL_GRAPH_ROOT, DEFAULT_SOCIAL_GRAPH_LABEL } from './profiles.ts'
import { normalizePublicKey } from './social.ts'
import { createAvatar, createUserRow } from './people.ts'
import { profileURL } from './routes.ts'
import { setupProfileReviews } from './reviews-ui.ts'
import type { PublishReview, ReviewAccount, ReviewQuery } from './reviews.ts'
import type { PublicProfile, SocialConnection } from './profiles.ts'

const element = domElement

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
  queryReviews?:ReviewQuery;getReviewAccount?:()=>ReviewAccount;publishReview?:PublishReview;onReviewSignIn?:()=>void;
}
export function setupProfiles({ page, getRelays, getContext = () => DEFAULT_SOCIAL_GRAPH_ROOT, isPreview = () => false, onContextChange = () => {}, onAuthorListings = () => {}, onMessage = () => {}, onNavigate = () => {}, onClose = () => {}, renderListings, queryReviews, getReviewAccount, publishReview, onReviewSignIn }: ProfileOptions) {
  const container = page ?? element('section', undefined, 'profile-page')
  container.setAttribute('aria-labelledby', 'public-profile-title')
  container.hidden = true
  const back = element('button', '←', 'button quiet profile-back')
  back.title = 'Back'
  back.setAttribute('aria-label', 'Back from profile')
  back.onclick = () => close({notify:true})
  const body = element('div', undefined, 'profile-content')
  const status = element('p', '', 'profile-status muted')
  status.setAttribute('role', 'status')
  container.replaceChildren(body, status)
  if (!page) document.body.append(container)
  let controller:AbortController|undefined, generation = 0, currentKey:string|undefined, destroyed = false
  let listingCleanup:(()=>void)|undefined, listingsActive=false, selectedView='listings'
  let reviews:ReturnType<typeof setupProfileReviews>|undefined, reviewSummaryButton:HTMLButtonElement|undefined, reviewTab:HTMLButtonElement|undefined
  const listingHost=element('div',undefined,'profile-listings')
  const panel=element('div',undefined,'profile-list-panel')
  panel.id='profile-list-panel';panel.setAttribute('role','tabpanel')
  const stopListings=()=>{listingCleanup?.();listingCleanup=undefined;listingsActive=false}
  type ProfileData=Awaited<ReturnType<typeof loadProfile>>
  type ProfileView={id:string;label:string;people?:{pubkey:string}[];empty?:string;note?:string}
  const connectionViews=(data?:ProfileData):ProfileView[]=>[
    {id:'known',label:data?`Known ${data.followedByKnown.length}`:'Known',people:data?.followedByKnown,empty:'No known followers found.',note:data?`Followed by people ${data.contextLabel} follows. Only ${data.coverage.secondHopLoaded} of ${data.coverage.directFollows ?? '?'} follow lists were loaded.`:undefined},
    {id:'following',label:data?`Following ${data.following.total ?? '—'}`:'Following',people:data?.following.items,empty:data?.following.total===null?'Follow list unavailable.':'This public list is empty.',note:data?.following.truncated?`Showing the first ${data.following.items.length} of ${data.following.total} follows.`:'Latest signed follow list observed on your servers.'},
    {id:'followers',label:data?`Followers ${data.followers.observedCount}`:'Followers',people:data?.followers.items,empty:'No followers found.',note:'Observed followers only. Servers can omit records; this is not a total follower count.'},
  ]
  const renderSections=(data?:ProfileData)=>{
    const tabs=element('div',undefined,'profile-tabs')
    tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Profile')
    const views:ProfileView[]=[{id:'listings',label:'Listings'},{id:'reviews',label:'Reviews'},...connectionViews(data)]
    const select=(view:ProfileView,button:HTMLButtonElement)=>{
      selectedView=view.id
      for(const tab of tabs.children){tab.setAttribute('aria-selected',String(tab===button));(tab as HTMLElement).tabIndex=tab===button?0:-1}
      panel.setAttribute('aria-labelledby',button.id)
      if(view.id==='listings'){
        panel.replaceChildren(listingHost)
        if(!listingsActive){
          listingsActive=true;listingHost.replaceChildren()
          if(renderListings){const cleanup=renderListings(currentKey,listingHost);if(typeof cleanup==='function')listingCleanup=cleanup}
          else {const browse=element('button','Browse listings','button secondary');browse.onclick=()=>{const key=currentKey;close();onAuthorListings(key)};listingHost.append(browse)}
        }
      }else if(view.id==='reviews'){
        stopListings()
        panel.replaceChildren(reviews.element)
      }else{
        stopListings()
        panel.replaceChildren(view.people?peopleList(view.people,view.empty):element('p','Loading connections…','muted small'))
      }
    }
    for(const view of views){
      const tab=element('button',view.label);tab.id=`profile-tab-${view.id}`;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',panel.id)
      tab.onclick=()=>select(view,tab)
      if(view.id==='reviews')reviewTab=tab
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
    controller?.abort(); stopListings(); reviews?.close(); reviews=undefined; reviewTab=undefined; reviewSummaryButton=undefined; generation++; currentKey=undefined; container.hidden=true
    if (notify && !destroyed) onClose()
  }
  const peopleList = (people, emptyText) => {
    const list = element('div', undefined, 'profile-people')
    if (!people.length) { list.append(element('p', emptyText, 'muted small')); return list }
    for (const person of people) {
      const button = createUserRow(person.pubkey, { size:34, className:'profile-person', onClick:() => open(person.pubkey) })
      list.append(button)
    }
    return list
  }
  const renderIdentity = (profile:PublicProfile, relation?:SocialConnection) => {
    const identity = element('div', undefined, 'profile-identity')
    const name = element('h1', profile.name)
    name.id = 'public-profile-title'
    const badge = createRelationshipBadge(relation)
    if (badge) name.append(badge)
    const heading = element('div')
    heading.append(name)
    reviewSummaryButton=element('button',reviews?.summary().label??'Reviews','text-button profile-review-summary')
    reviewSummaryButton.onclick=()=>reviewTab?.click()
    heading.append(reviewSummaryButton)
    identity.append(back, createAvatar(profile.pubkey, {size:76}), heading)
    body.append(identity)
    if (profile.about) body.append(element('p', profile.about, 'profile-about'))
    if (profile.website) {
      const link = element('a', new URL(profile.website).hostname, 'profile-website')
      link.href = profile.website; link.target = '_blank'; link.rel = 'noopener noreferrer'
      body.append(link)
    }
    if (profile.nip05) body.append(element('p', `${profile.nip05} · Self-declared address`, 'profile-address muted small'))
  }
  const renderActions = (profile:PublicProfile) => {
    const actions = element('div', undefined, 'profile-actions')
    const share = element('button', 'Copy profile link', 'text-button')
    share.onclick = async () => {
      try { await navigator.clipboard.writeText(profileURL(profile.pubkey, location.href)); status.textContent = 'Profile link copied' }
      catch { status.textContent = 'Copy the address from your browser.' }
    }
    const message = element('button', 'Message', 'button primary'); message.onclick = () => { close(); onMessage(profile.pubkey) };
    actions.append(message, share); body.append(actions)

  }
  const renderCached = (key:string) => {
    const profile=readProfileMetadata(key,{relays:getRelays()})
    body.replaceChildren(); renderIdentity(profile); renderActions(profile); renderSections()
    return profile.eventId
  }
  const render = data => {
    const profile = data.profile
    body.replaceChildren(); renderIdentity(profile,data.relation)
    const connection = element('div', undefined, 'profile-connection')
    const connectionText = data.relation.distance === 1 ? `Followed by ${data.contextLabel}` : data.followedByKnown.length ? `Followed by ${data.followedByKnown.length} known ${data.followedByKnown.length === 1 ? 'person' : 'people'}` : ''
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
    if(data.relation.distance !== null)network.append(element('p',`Follow distance: ${data.relation.distance}`,'small muted'))
    for(const view of views)network.append(element('p',view.note,'small muted'))
    for(const warning of new Set(data.coverage.warnings))network.append(element('p',String(warning),'small muted'))
    const copy=element('button','Copy user ID','text-button');copy.onclick=async()=>{try{await navigator.clipboard.writeText(npubEncode(profile.pubkey));status.textContent='User ID copied'}catch{status.textContent='Could not copy this user ID.'}};network.append(copy)
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
    status.textContent = ''
  }

  async function open(pubkey:string, {navigate=true}: {navigate?:boolean} = {}) {
    if (destroyed) return
    let key:string
    try { key = normalizePublicKey(pubkey) } catch (error) { status.textContent = error.message; return }
    const beforeNavigate=generation
    if (navigate) onNavigate(key)
    // A router may synchronously reopen this profile without navigation.
    if (generation!==beforeNavigate || destroyed) return
    controller?.abort(); stopListings(); reviews?.close(); reviewTab=undefined; reviewSummaryButton=undefined; selectedView='listings'; controller = new AbortController(); const run = ++generation
    currentKey = key; container.hidden=false; container.scrollTop=0
    reviews=setupProfileReviews({target:key,query:queryReviews,getAccount:getReviewAccount,publish:publishReview,preview:isPreview(),onSignIn:onReviewSignIn,onProfile:pubkey=>void open(pubkey),onSummary:value=>{if(run===generation&&reviewSummaryButton)reviewSummaryButton.textContent=value.label}})
    let displayed=renderCached(key)
    if (isPreview()) { status.textContent = 'Profiles are available in live mode.'; return }
    status.textContent = displayed ? 'Loading connections…' : 'Loading profile…'
    // loadProfile hydrates metadata before its bounded graph lookup completes.
    // Surface that cache progress without issuing a duplicate metadata query.
    const progress=setInterval(()=>{
      if(run!==generation || destroyed)return
      const cached=readProfileMetadata(key,{relays:getRelays()})
      if(cached.eventId!==displayed){displayed=renderCached(key);status.textContent='Loading connections…'}
    },200)
    const stopProgress=()=>clearInterval(progress)
    controller.signal.addEventListener('abort',stopProgress,{once:true})
    try {
      const data = await loadProfile(key, { relays: getRelays(), contextPubkey: getContext() || DEFAULT_SOCIAL_GRAPH_ROOT, signal: controller.signal })
      if (run !== generation || destroyed) return
      render(data)
    } catch (error) { if (run === generation && error.name !== 'AbortError') status.textContent = error.message || 'Could not load this profile.' }
    finally { stopProgress() }
  }
  return { open, close, refreshReviews(){reviews?.refresh()}, destroy() { destroyed = true; close(); container.replaceChildren(); if(!page)container.remove() } }
}
