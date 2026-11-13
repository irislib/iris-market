<script lang="ts">
  import {npubEncode} from 'nostr-tools/nip19'
  import {DEFAULT_SOCIAL_GRAPH_ROOT, DEFAULT_SOCIAL_GRAPH_LABEL} from '../profiles.ts'
  import {normalizePublicKey} from '../social.ts'
  import {createAvatar, createUserRow} from '../people.ts'
  import {profileURL} from '../routes.ts'
  import {translatedParagraph} from '../translation-content.ts'
  import {place} from '../svelte/place.ts'
  import type {ProfileState, ProfileView} from './state.svelte.ts'
  import RelationshipBadge from './RelationshipBadge.svelte'

  let {profile: p}: {profile: ProfileState} = $props()
  let tabs: HTMLElement
  let contextError = $state('')
  let contextInput = $state('')

  const o = p.options
  const relation = $derived(p.data?.relation)
  const selected = $derived(p.views.find(view => view.id === p.view) ?? p.views[0])
  const observed = $derived(p.followerPeople)
  const personRow = (pubkey: string, size: number, className: string) => () =>
    createUserRow(pubkey, {size, className, href: profileURL(pubkey, location.href), onClick: () => void p.open(pubkey)})

  $effect(() => { if (p.data) contextInput = npubEncode(p.data.contextPubkey) })

  function close() { p.close(); if (!p.destroyed) o.onClose?.() }
  function message() { const key = p.key; p.close(); o.onMessage?.(key) }
  function browse() { const key = p.key; p.close(); o.onAuthorListings?.(key) }
  function openFollowers() { p.select('followers'); (tabs?.querySelector('#profile-tab-followers') as HTMLElement)?.focus() }

  async function copy(text: string, done: string, failed: string) {
    try { await navigator.clipboard.writeText(text); p.setStatus(done) } catch { p.setStatus(failed) }
  }

  function keydown(event: KeyboardEvent, index: number) {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const total = p.views.length
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? total - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + total) % total
    p.select(p.views[next].id)
    queueMicrotask(() => (tabs.children[next] as HTMLElement)?.focus())
  }

  async function useContext(key: string) {
    try { await p.changeContext(key) } catch { contextError = 'Could not change the network profile.' }
  }
  function submitContext(event: SubmitEvent) {
    event.preventDefault()
    try { void useContext(normalizePublicKey(contextInput)) } catch (cause) { contextError = cause.message }
  }

  function listings(host: HTMLElement, key: string) {
    if (!o.renderListings) return
    const cleanup = o.renderListings(key, host)
    return {destroy() { if (typeof cleanup === 'function') cleanup() }}
  }
  function collections(host: HTMLElement, key: string) {
    const stop = o.renderCollections(key, host)
    return {destroy: stop}
  }
</script>

<div class="profile-content">
  {#if p.key && p.profile}
    {@const profile = p.profile}
    {@const data = p.data}
    <div class="profile-heading">
      <div class="profile-identity">
        <button class="button quiet profile-back" title="Back" aria-label="Back from profile" onclick={close}>←</button>
        {#key profile.pubkey}<span hidden use:place={() => createAvatar(profile.pubkey, {size: 76})}></span>{/key}
        <div>
          <h1 id="public-profile-title"><RelationshipBadge {relation} />{profile.name}</h1>
          <button class="text-button profile-review-summary" onclick={() => p.select('reviews')}>{p.reviewLabel}</button>
        </div>
      </div>
      {#if observed.length}
        <div class="profile-followed-by" aria-label="Followers from observed public follow lists">
          <button type="button" class="text-button" onclick={openFollowers}>Followed by</button>
          {#each observed.slice(0, 3) as person, index (person.pubkey)}
            {#if index}<span class="profile-followed-separator">,</span>{/if}
            <span hidden use:place={personRow(person.pubkey, 20, 'profile-followed-person')}></span>
          {/each}
          {#if observed.length > 3}
            <button type="button" class="text-button" onclick={openFollowers}>and {observed.length - 3} {observed.length === 4 ? 'other' : 'others'}</button>
          {/if}
        </div>
      {/if}
      {#if profile.about}
        {#key profile.pubkey + profile.about}<span hidden use:place={() => translatedParagraph(profile.about, 'profile-about')}></span>{/key}
      {/if}
      {#if profile.website}
        <a class="profile-website" href={profile.website} target="_blank" rel="noopener noreferrer">{new URL(profile.website).hostname}</a>
      {/if}
      {#if profile.nip05}<p class="profile-address muted small">{profile.nip05} · Self-declared address</p>{/if}
    </div>
    {#if data && (data.relation.distance === 1 || data.mutualFollowing || data.followsContext)}
      <div class="profile-connection">
        {#if data.relation.distance === 1}<p>Followed by {data.contextLabel}</p>{/if}
        {#if data.mutualFollowing}<p class="small">Mutual follows with {data.contextLabel}</p>
        {:else if data.followsContext}<p class="small">Follows {data.contextLabel}</p>{/if}
      </div>
    {/if}
    <div class="profile-actions">
      <button class="button primary" onclick={message}>Message</button>
      <button class="text-button" onclick={() => copy(profileURL(profile.pubkey, location.href), 'Profile link copied', 'Copy the address from your browser.')}>Copy profile link</button>
    </div>
    <div class="profile-tabs" role="tablist" aria-label="Profile" bind:this={tabs}>
      {#each p.views as view, index (view.id)}
        <button id="profile-tab-{view.id}" role="tab" aria-controls="profile-list-panel" aria-selected={view.id === selected.id}
          tabindex={view.id === selected.id ? 0 : -1} onclick={() => p.select(view.id)} onkeydown={event => keydown(event, index)}>{view.label}</button>
      {/each}
    </div>
    {#key p.key}
      <div class="profile-list-panel" id="profile-list-panel" role="tabpanel" aria-labelledby="profile-tab-{selected.id}">
        {#if selected.id === 'listings'}
          {#if o.renderListings}
            <div class="profile-listings" use:listings={p.key}></div>
          {:else}
            <div class="profile-listings"><button class="button secondary" onclick={browse}>Browse listings</button></div>
          {/if}
        {:else if selected.id === 'collections'}
          <div class="profile-collections" use:collections={p.key}></div>
        {:else if selected.id === 'reviews'}
          {#if p.reviews}{#key p.reviews}<span hidden use:place={() => p.reviews.element}></span>{/key}{/if}
        {:else if selected.id === 'followers'}
          {@render people(p.followerPeople, p.followers ? 'No followers found.' : '')}
          {#if !p.followers}
            <p class={p.followersError ? 'muted small' : 'muted small loading-state'} role="status">{p.followersError || 'Loading followers…'}</p>
            {#if p.followersError}<button class="text-button" onclick={() => void p.requestFollowers()}>Try again</button>{/if}
          {/if}
        {:else if selected.people}
          {@render people(selected.people, selected.empty)}
        {:else}
          <p class="muted small loading-state">Loading connections…</p>
        {/if}
      </div>
    {/key}
    {#if data}
      <details class="profile-network">
        <summary>Network details</summary>
        <p class="small muted">Connections through {data.contextLabel}.</p>
        <p class="small muted" hidden={relation.distance === null}>{relation.distance === null ? '' : `Follow distance: ${relation.distance}`}</p>
        <p class="small muted">Known followers are people {data.contextLabel} follows, from loaded public follow lists. Only {data.coverage.secondHopLoaded} of {data.coverage.directFollows ?? '?'} follow lists were loaded.</p>
        {#each p.views.filter((view): view is ProfileView & {note: string} => !!view.note) as view}<p class="small muted">{view.note}</p>{/each}
        {#each [...new Set(data.coverage.warnings)] as warning}<p class="small muted">{String(warning)}</p>{/each}
        <button class="text-button" onclick={() => copy(npubEncode(profile.pubkey), 'User ID copied', 'Could not copy this user ID.')}>Copy user ID</button>
        <form onsubmit={submitContext}>
          <label for="profile-context">Public profile for connections</label>
          <input id="profile-context" bind:value={contextInput} placeholder="Public user ID" autocomplete="off" spellcheck="false">
          <p class="error small" role="alert">{contextError}</p>
          <button class="button secondary" type="submit">Use profile</button>
          <button class="text-button" type="button" onclick={() => void useContext(DEFAULT_SOCIAL_GRAPH_ROOT)}>Use {DEFAULT_SOCIAL_GRAPH_LABEL}</button>
        </form>
        <p class="small muted">Uses public follow lists. This does not sign in or follow anyone.</p>
      </details>
    {/if}
  {/if}
</div>
<p class="profile-status muted" role="status" bind:this={p.status}></p>

{#snippet people(list: {pubkey: string}[], emptyText: string)}
  <div class="profile-people">
    {#each list as person (person.pubkey)}
      <span hidden use:place={personRow(person.pubkey, 34, 'profile-person')}></span>
    {:else}
      <p class="muted small">{emptyText}</p>
    {/each}
  </div>
{/snippet}
