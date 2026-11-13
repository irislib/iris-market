<script lang="ts">
  import {nip19} from 'nostr-tools'
  import {nameFor} from '../people.ts'
  import {listingURL, profileURL} from '../routes.ts'
  import {matchCandidates, type MatchView} from '../private-matches.ts'
  import type {PrivateMatchState} from './state.svelte.ts'

  let {matches, getListings}: {matches: PrivateMatchState; getListings: () => any[]} = $props()

  let dialog: HTMLDialogElement
  let compose: HTMLDetailsElement
  let selected = $state('')
  let helper = $state('')
  let summary = $state('')
  let side = $state<'offer' | 'request'>('request')
  let draft = $state('')
  let confirming = $state(false)
  const chat = $derived(matches.chats.find(c => c.id === matches.openChat))
  const proposalOf = (id: string) => id.slice('match:'.length)
  // Filled glyphs, drawn with the text colour.
  const icons = {
    chat: 'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
    mask: 'M12 4C6 4 2 5.5 2 9c0 5 4 9 7.5 9 1.1 0 1.8-.9 2.5-2 .7 1.1 1.4 2 2.5 2C18 18 22 14 22 9c0-3.5-4-5-10-5Zm-4.5 5.5c1.3 0 2.3.6 2.5 1.5-.5.8-1.5 1.3-2.5 1.3S5.5 11.8 5 11c.2-.9 1.2-1.5 2.5-1.5Zm9 0c1.3 0 2.3.6 2.5 1.5-.5.8-1.5 1.3-2.5 1.3s-2-.5-2.5-1.3c.2-.9 1.2-1.5 2.5-1.5Z',
    person: 'M12 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 12c5 0 9 2.5 9 6v2H3v-2c0-3.5 4-6 9-6Z',
  }

  const until = (at: number) => new Date(at * 1000).toLocaleDateString()
  const peerNames = $derived(matches.peers.map(key => nameFor(key) + ' · ' + key.slice(-6)))

  $effect(() => {
    if (matches.dialogOpen && !dialog.open) dialog.showModal()
    else if (!matches.dialogOpen && dialog.open) dialog.close()
  })

  function closed() {
    matches.dialogOpen = false
    selected = helper = summary = draft = matches.error = matches.openChat = ''
    confirming = false
    side = 'request'
    compose.open = false
  }

  async function send() {
    try {
      const raw = helper.trim()
      const decoded = raw.startsWith('npub1') ? nip19.decode(raw) : null
      const pubkey = decoded?.type === 'npub' ? decoded.data : raw
      if (await matches.act({op: 'share', helper: pubkey, side, summary})) {
        summary = ''
        compose.open = false
      }
    } catch { matches.error = 'Paste your helper’s profile ID. It starts with npub.' }
  }

  function pairStatus(pair: MatchView['pairs'][string]) {
    if (pair.introduced) return 'Introduced. They now chat privately, and you can’t see their messages.'
    if (pair.votes.includes(false)) return 'One person declined.'
    if (pair.votes.every(vote => vote === true)) return 'Both agreed. Introducing them shares a private alias for each, not their profiles.'
    return pair.votes.some(vote => vote === true) ? 'One person agreed. Waiting for the other.' : 'Waiting for both to reply.'
  }

  function candidatesFor(v: MatchView, id: string) {
    const inventory = getListings()
    return matchCandidates(v, id, inventory)
      .filter(c => c.kind !== 'private' || !Object.values(v.pairs).some(p => p.entries.includes(id) && p.entries.includes(c.id)))
      .map(c => ({...c, listing: inventory.find(item => item.id === c.id)}))
  }

  function leadHref(listing: string) {
    try { return listingURL(listing.replace(/^30402:/, '')) } catch { return null }
  }

  function interestStatus(p: MatchView['interests'][string]) {
    if (p.chat) return p.connected ? 'Introduced. You can chat privately.' : 'Introduced. Connecting privately…'
    if (p.contact) return 'You have been introduced.'
    if (p.vote === null) return 'If you both agree, you’ll chat as private aliases. Your profile stays hidden unless you choose to share it.'
    return p.vote ? 'You agreed. Waiting for the other person and your helper.' : 'You declined.'
  }

  async function sendDraft() {
    if (chat && await matches.send(chat.id, draft)) draft = ''
  }

  async function share() {
    if (chat && await matches.act({op: 'reveal', proposal: proposalOf(chat.id)})) confirming = false
  }

  function viewProfile(key: string) {
    dialog.close()
    location.assign(profileURL(key))
  }

  function openChat(id: string) {
    confirming = false
    matches.openChat = id
    matches.markRead(id)
  }
</script>

<dialog bind:this={dialog} class="match-dialog" aria-labelledby="private-match-heading" onclose={closed}>
  <button class="dialog-close icon-button" aria-label="Close private matches" onclick={() => dialog.close()}>×</button>
  <h2 id="private-match-heading">Private matches</h2>
  <div class="match-switch" role="group" aria-label="Private matches view">
    <button aria-pressed={!matches.helperView} onclick={() => matches.helperView = false}>My matches</button>
    <button aria-pressed={matches.helperView} onclick={() => matches.helperView = true}>Helping</button>
  </div>
  <details bind:this={compose} class="match-compose" hidden={matches.helperView}>
    <summary>Ask a helper</summary>
    <p>Your helper may show this summary privately to someone with a possible match. Leave names and contact details out. It expires in seven days.</p>
    <select bind:value={side} aria-label="Offer or request">
      <option value="request">I’m looking for</option>
      <option value="offer">I’m offering</option>
    </select>
    <select aria-label="Choose from your conversations" hidden={!matches.peers.length}
      value={matches.peers.includes(helper) ? helper : ''} onchange={e => { if (e.currentTarget.value) helper = e.currentTarget.value }}>
      <option value="">Choose from your conversations</option>
      {#each matches.peers as key, i (key)}<option value={key}>{peerNames[i]}</option>{/each}
    </select>
    <input bind:value={helper} placeholder="Helper’s profile ID (npub…)" aria-label="Helper" autocomplete="off">
    <textarea bind:value={summary} placeholder="e.g. Looking for a cargo bike with two seats" aria-label="Shareable summary" maxlength="200"></textarea>
    <p class="small muted">{matches.canSend ? '' : 'This device needs approval before it can send.'}</p>
    <button class="button primary" disabled={!matches.canSend} onclick={send}>Send to helper privately</button>
  </details>
  <p class="error" role="alert">{matches.error}</p>
  {#if chat}
    <section class="match-chat" aria-label="Private match chat">
      <button type="button" class="text-button" onclick={() => { matches.openChat = ''; confirming = false }}>← Back to matches</button>
      <h3>{chat.title}</h3>
      <p class="match-who small">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={icons.mask}/></svg>
        <span>{chat.shared ? 'You shared your profile in this chat.' : 'You appear as a private alias. They can’t see your profile.'}</span>
      </p>
      {#if chat.revealed}
        <p class="match-who small">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={icons.person}/></svg>
          <span>They shared their profile: <strong>{nameFor(chat.revealed)}</strong></span>
          <button type="button" class="text-button" onclick={() => viewProfile(chat.revealed!)}>View profile</button>
        </p>
      {/if}
      <ol class="match-messages" aria-live="polite">
        {#each chat.messages as message (message.id)}
          <li class:mine={message.mine}>
            {message.text}
            {#if message.mine && message.delivery === 'pending'}<span class="match-queued"> · Not sent yet</span>{/if}
          </li>
        {/each}
      </ol>
      {#if chat.connected}
        <textarea bind:value={draft} placeholder="Write a message" aria-label="Message" maxlength="8000"></textarea>
        <div class="match-actions">
          <button type="button" class="button primary" disabled={!draft.trim() || !matches.canSend} onclick={sendDraft}>Send</button>
          {#if !chat.shared && !confirming}
            <button type="button" class="button secondary" onclick={() => confirming = true}>Share my profile…</button>
          {/if}
        </div>
        {#if confirming}
          <div class="match-confirm" role="group" aria-label="Share your profile">
            <p>Share your profile with this person? They’ll see your name, profile and public listings, and can find you outside this chat. This can’t be undone.</p>
            <button type="button" class="button primary" onclick={share}>Share profile</button>
            <button type="button" class="button secondary" onclick={() => confirming = false}>Cancel</button>
          </div>
        {/if}
      {:else}
        <p class="small muted">Connecting privately. You can write as soon as you’re connected; nothing you type is shared before that.</p>
      {/if}
    </section>
  {/if}
  <div class="match-rows" hidden={!!chat}>
    {#if matches.dialogOpen && matches.view}
      {@const v = matches.view}
      {#if matches.helperView}
        {#each Object.entries(v.pairs) as [proposal, pair] (proposal)}
          <div class="match-card">
            <strong>{pair.entries.map(id => v.received[id]?.summary).join(' · ')}</strong>
            <p class="small muted">{pairStatus(pair)}</p>
            {#if pair.votes.every(vote => vote === true) && !pair.introduced}
              <button type="button" class="button secondary" onclick={() => void matches.act({op: 'introduce', proposal})}>Introduce privately</button>
            {/if}
          </div>
        {/each}
        {#each Object.values(v.received) as entry (entry.id)}
          <div class="match-card">
            <strong>{entry.summary}</strong>
            <p class="small muted">{(entry.side === 'offer' ? 'Offer from ' : 'Request from ') + nameFor(entry.peer) + ' · Until ' + until(entry.expires_at)}</p>
            <button type="button" class="button secondary" onclick={() => selected = entry.id}>Find matches</button>
            {#if selected === entry.id}
              {@const candidates = candidatesFor(v, entry.id)}
              {#each candidates as candidate (candidate.kind + candidate.id)}
                <div class="match-card">
                  <strong>{candidate.summary}</strong>
                  <p class="small muted">{candidate.kind === 'private' ? 'Shared privately with you' : 'Public listing'}</p>
                  <button type="button" class="button secondary" onclick={() => candidate.kind === 'private'
                    ? void matches.act({op: 'suggest', left: entry.id, right: candidate.id})
                    : void matches.act({op: 'send_public', entry: entry.id, listing: candidate.id}, candidate.listing)}>
                    {candidate.kind === 'private' ? 'Ask both privately' : 'Send public listing privately'}
                  </button>
                </div>
              {:else}
                <p class="small muted">No new matches right now.</p>
              {/each}
            {/if}
          </div>
        {/each}
        {#if !Object.keys(v.pairs).length && !Object.keys(v.received).length}
          <p>Offers and requests shared with you will appear here.</p>
        {/if}
      {:else}
        {@const leads = Object.values(v.public_leads).map(lead => ({lead, href: leadHref(lead.listing)})).filter(l => l.href)}
        {#each Object.entries(v.interests) as [proposal, p] (proposal)}
          <div class="match-card">
            <span class="match-label">Possible match from your helper</span>
            <strong>{p.summary}</strong>
            <p class="small muted">{interestStatus(p)}</p>
            {#if p.vote === null}
              <button type="button" class="button secondary" onclick={() => void matches.act({op: 'vote', proposal, accept: true})}>Agree to introduction</button>
              <button type="button" class="button secondary" onclick={() => void matches.act({op: 'vote', proposal, accept: false})}>Decline</button>
            {/if}
            {#if p.chat}
              {@const unread = matches.unread[p.chat] ?? 0}
              <button type="button" class="button secondary match-open" onclick={() => openChat(p.chat!)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={icons.chat}/></svg>
                Open private chat{#if unread}<span class="nav-unread nav-unread-count" aria-label={unread + ' new'}>{unread}</span>{/if}
              </button>
            {:else if p.contact}
              <button type="button" class="button secondary" onclick={() => { dialog.close(); void matches.api.openChat(p.contact) }}>Open private chat</button>
            {/if}
          </div>
        {/each}
        {#each leads as {lead, href}}
          <div class="match-card">
            <strong>{lead.title}</strong>
            <p class="small muted">Public listing from your helper</p>
            <a {href}>Open public listing</a>
          </div>
        {/each}
        {#each Object.values(v.sent) as entry (entry.id)}
          <div class="match-card">
            <strong>{entry.summary}</strong>
            <p class="small muted">{(entry.side === 'offer' ? 'Your offer' : 'Your request') + ' · Helper: ' + nameFor(entry.peer) + ' · Until ' + until(entry.expires_at)}</p>
            <button type="button" class="button secondary" onclick={() => void matches.act({op: 'withdraw', entry: entry.id})}>Withdraw</button>
          </div>
        {/each}
        {#if !Object.keys(v.interests).length && !leads.length && !Object.keys(v.sent).length}
          <p>Your private offers, requests and replies will appear here.</p>
        {/if}
      {/if}
    {/if}
  </div>
</dialog>
