<script lang="ts">
  import {createUserRow} from '../people.ts'
  import {place} from '../svelte/place.ts'
  import ChatMessage from './ChatMessage.svelte'
  import type {AccountController, ChatRowView} from './controller.svelte.ts'

  let {c}: {c: AccountController} = $props()
  const view = $derived(c.inboxView)
  const pressed = (value: boolean) => view.revision === 0 ? undefined : value

  function chatRow(row: ChatRowView) {
    const node = createUserRow(row.pubkey, {size: 36, className: 'chat-row', onClick: () => c.chooseRow(row)})
    node.setAttribute('aria-pressed', String(row.pressed))
    if (row.title !== undefined) node.append(text('span', row.title, 'chat-thread-title'))
    if (row.unread) {
      const dot = text('span', undefined, 'unread-dot'); dot.setAttribute('aria-hidden', 'true')
      node.append(dot, text('span', 'Unread messages', 'unread-label'))
    }
    return node
  }
  function text(tag: 'span', value: string | undefined, className: string) {
    const node = document.createElement(tag); if (value !== undefined) node.textContent = value; node.className = className; return node
  }
  /** Escrow trades render through the shared escrow helper at this position. */
  function escrow(anchor: HTMLElement, [peer, listing]: [string | undefined, string | undefined]) {
    const scratch = document.createElement('div')
    c.options.renderEscrowTrades(scratch, peer, listing)
    const nodes = [...scratch.childNodes]
    anchor.before(...nodes)
    return {destroy() { for (const node of nodes) node.parentNode?.removeChild(node) }}
  }
  function submit(event: SubmitEvent, action: () => void) { event.preventDefault(); action() }
</script>

<button data-close class="dialog-close icon-button" aria-label="Close messages" onclick={() => c.inbox.close()}>×</button><h2>Messages</h2>{#key view.revision}{#if view.escrow === 'inbox'}<span hidden use:escrow={[undefined, c.selectedContext?.listing]}></span>{/if}{/key}<div class="chat-grouping" role="group" aria-label="Group conversations"><button type="button" id="chat-threads" aria-pressed={pressed(view.threadMode)} onclick={() => c.setThreadMode(true)}>Threads</button><button type="button" id="chat-people" aria-pressed={pressed(!view.threadMode)} onclick={() => c.setThreadMode(false)}>People</button></div><div class="chat-shell"><aside class="chat-sidebar"><form id="chat-new" hidden={c.chatNewHidden} onsubmit={e => submit(e, () => c.startChat())}><label class="sr-only" for="chat-recipient">User ID or private invitation</label><input id="chat-recipient" bind:value={c.chatRecipient} placeholder="User ID or invitation" autocomplete="off"><button class="button secondary" aria-label="Start conversation">New</button></form><div id="chat-list">{#key view.revision}{#each view.rows as row}<span hidden use:place={() => chatRow(row)}></span>{/each}{/key}</div></aside><section class="chat-main"><div id="chat-person">{#key view.revision}{#if view.person}{@const person = view.person}<span hidden use:place={() => createUserRow(person.pubkey, {size: 36, onClick: () => c.showPerson(person.pubkey)})}></span>{#if person.order}<button type="button" class="text-button chat-context" onclick={() => c.showOrder(person.order.id)}>{person.order.label}</button>{:else if person.listingNote !== undefined}<p class="small muted">{person.listingNote}</p>{/if}{#if view.escrow === 'person'}<span hidden use:escrow={[person.pubkey, c.selectedContext?.listing]}></span>{/if}{#if person.noticeOnly}<p class="small muted">New chat messages use your Market profile.</p>{/if}{#if person.timer}<button type="button" class="text-button" disabled={person.timer.disabled} onclick={() => c.editConversationTimer(person.pubkey, person.timer.seconds)}>{person.timer.label}</button><p class="small muted">{person.timer.description}</p>{/if}{/if}{/key}</div><div id="chat-messages" role="log" aria-live="polite" bind:this={c.area} onscroll={c.scheduleSeen}>{#key view.revision}{#each view.messages as message}<ChatMessage {c} {message} revision={view.revision} nearBottom={view.nearBottom} />{/each}{#if view.empty}<p class="muted chat-empty">Choose a conversation or enter a user ID.</p>{/if}{/key}</div><p id="chat-status" class="small muted" role="status">{c.chatStatus}</p><p id="chat-error" class="error" role="alert">{c.chatError}</p><form id="chat-send" hidden={c.sendHidden} onsubmit={e => submit(e, () => c.send())}><label class="sr-only" for="chat-text">Message</label><textarea id="chat-text" bind:this={c.textInput} bind:value={c.chatText} placeholder="Message" rows="2" maxlength="8000"></textarea><button id="chat-send-button" class="button primary" disabled={c.sendDisabled}>Send</button></form></section></div>
