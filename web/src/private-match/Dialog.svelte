<script lang="ts">
  import {nip19} from 'nostr-tools'
  import {nameFor} from '../people.ts'
  import {listingURL} from '../routes.ts'
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
  const chat = $derived(matches.chats.find(c => c.id === matches.openChat))

  const until = (at: number) => new Date(at * 1000).toLocaleDateString()
  const peerNames = $derived(matches.peers.map(key => nameFor(key) + ' · ' + key.slice(-6)))

  $effect(() => {
    if (matches.dialogOpen && !dialog.open) dialog.showModal()
    else if (!matches.dialogOpen && dialog.open) dialog.close()
  })

  function closed() {
    matches.dialogOpen = false
    selected = helper = summary = draft = matches.error = matches.openChat = ''
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
    } catch { matches.error = 'Enter the helper’s public key.' }
  }

  function pairStatus(pair: MatchView['pairs'][string]) {
    if (pair.introduced) return 'Introduction started'
    if (pair.votes.includes(false)) return 'Declined'
    return pair.votes.every(vote => vote === true) ? 'Both agreed' : 'Waiting for replies'
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

  const interestStatus = (p: MatchView['interests'][string]) =>
    p.chat || p.contact ? 'You have been introduced.' : p.vote === null
      ? 'If you both agree, you’ll chat through a new alias made only for this match. Your profile stays private.'
      : p.vote ? 'You agreed. Waiting for the introduction.' : 'You declined.'

  async function sendDraft() {
    if (chat && await matches.send(chat.id, draft)) draft = ''
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
    <input bind:value={helper} placeholder="Helper’s npub or public key" aria-label="Helper" autocomplete="off">
    <textarea bind:value={summary} placeholder="e.g. Looking for a cargo bike with two seats" aria-label="Shareable summary" maxlength="200"></textarea>
    <p class="small muted">{matches.canSend ? '' : 'Waiting for device authorization before sending.'}</p>
    <button class="button primary" disabled={!matches.canSend} onclick={send}>Send to helper privately</button>
  </details>
  <p class="error" role="alert">{matches.error}</p>
  {#if chat}
    <section class="match-chat" aria-label="Private match chat">
      <button type="button" class="button secondary" onclick={() => matches.openChat = ''}>Back</button>
      <h3>{chat.title}</h3>
      <p class="small muted">Via private match. You both appear as aliases made for this chat.</p>
      <ol class="match-messages">
        {#each chat.messages as message (message.id)}
          <li class:mine={message.mine}>
            {message.text}
            {#if message.mine && message.delivery === 'pending'}<span class="small muted"> · Queued</span>{/if}
          </li>
        {/each}
      </ol>
      {#if chat.connected}
        <textarea bind:value={draft} placeholder="Write a message" aria-label="Message" maxlength="8000"></textarea>
        <button type="button" class="button primary" disabled={!draft.trim() || !matches.canSend} onclick={sendDraft}>Send</button>
      {:else}
        <p class="small muted">Connecting privately. You can write once the other person’s app says hello.</p>
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
            <p class="small muted">{(entry.side === 'offer' ? 'Offer from ' : 'Request from ') + nameFor(entry.peer) + ' · Expires ' + until(entry.expires_at)}</p>
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
            <strong>{p.summary}</strong>
            <p class="small muted">{interestStatus(p)}</p>
            {#if p.vote === null}
              <button type="button" class="button secondary" onclick={() => void matches.act({op: 'vote', proposal, accept: true})}>Agree to introduction</button>
              <button type="button" class="button secondary" onclick={() => void matches.act({op: 'vote', proposal, accept: false})}>Decline</button>
            {/if}
            {#if p.chat}
              <button type="button" class="button secondary" onclick={() => matches.openChat = p.chat}>Open private chat</button>
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
            <p class="small muted">{(entry.side === 'offer' ? 'Your offer' : 'Your request') + ' with ' + nameFor(entry.peer) + ' · Expires ' + until(entry.expires_at)}</p>
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
