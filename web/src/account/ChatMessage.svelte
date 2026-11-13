<script lang="ts">
  import {revealChatPicker} from '../chat-picker-state.ts'
  import {translatedParagraph} from '../translation-content.ts'
  import {containsCashu, parsePaymentNote, renderPaymentNote, renderCashuContent} from '../cashu-content.ts'
  import type {AccountController} from './controller.svelte.ts'

  let {c, message, revision, nearBottom}: {c: AccountController; message: any; revision: number; nearBottom: boolean} = $props()

  const reactionChoices = [['👍', 'Thumbs up'], ['❤️', 'Heart'], ['😂', 'Laugh'], ['🎉', 'Celebrate'], ['😮', 'Surprised'], ['🙏', 'Thanks']]
  const labels = {queued: 'Queued', sent: 'Sent', delivered: 'Delivered', seen: 'Seen', failed: 'Not sent'}
  const delivery = labels[message.delivery] || 'Sent'
  const notice = message.id.startsWith('notice-')
  const payment = parsePaymentNote(message.text)
  const cashu = !payment && containsCashu(message.text)
  const translated = !payment && !cashu && !message.mine && !message.system && !notice
  const date = new Date(message.createdAt * 1000)
  const orderLink = typeof message.orderId === 'string' && message.orderId.length <= 160
  const canSend = !!c.state.canSend
  let item: HTMLElement, picker: HTMLDetailsElement, options: HTMLElement
  const active = () => c.active(revision)

  /** Payment notes, tokens and translatable prose come from their existing renderers. */
  function body(node: HTMLElement) {
    if (payment) { node.append(renderPaymentNote(payment)); return }
    if (translated) { node.append(c.prose(message, text => translatedParagraph(text))); return }
    if (!cashu) return
    const placeholder = document.createElement('p'); placeholder.className = 'muted'; placeholder.textContent = 'Cashu token'; node.append(placeholder)
    void renderCashuContent(message.text, {isActive: active, onToken: token => { if (!active()) return; c.inbox.hide(); return c.options.onToken(token) }})
      .then(content => { if (active()) { node.replaceChildren(content); if (nearBottom) c.area.scrollTop = c.area.scrollHeight } })
      .catch(() => { if (active()) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Token unavailable. Reopen this conversation to retry.'; node.replaceChildren(p) } })
  }
  function react(emoji: string) { c.react(revision, item, message.id, emoji) }
  function toggled() { if (picker.open && active()) requestAnimationFrame(() => { if (picker.open && active()) revealChatPicker(c.area, options) }) }
</script>

<div class="chat-message {message.mine ? 'mine' : ''}" data-message-id={message.id} data-mine={String(message.mine)} bind:this={item}><div use:body>{#if !payment && !cashu && !translated}<p>{message.text}</p>{/if}</div>{#if orderLink}<button type="button" class="button secondary chat-order-link" onclick={() => { if (active()) c.showOrder(message.orderId) }}>View order</button>{/if}<div class="chat-message-meta">{#if notice}<span>Anonymous notice</span>{/if}<time datetime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})}</time>{#if message.mine}<span class="chat-delivery" aria-label={'Message ' + delivery.toLowerCase()}>{delivery}</span>{/if}{#if !notice}<details class="chat-reaction-picker" data-message-id={message.id} open={c.pickerState.isOpen(message.id)} bind:this={picker} ontoggle={toggled}><summary aria-label="React to message">☺</summary><div class="chat-reaction-options" role="group" aria-label="Choose a reaction" bind:this={options}>{#each reactionChoices as [emoji, label]}<button type="button" aria-label={label} disabled={!canSend} onclick={() => { picker.open = false; react(emoji) }}>{emoji}</button>{/each}</div></details>{/if}</div>{#if !notice && message.reactions?.length}<div class="chat-reactions" role="group" aria-label="Message reactions">{#each message.reactions as reaction}<button type="button" class="chat-reaction-chip" aria-pressed={!!reaction.reacted_by_me} aria-label={`${reaction.emoji}, ${reaction.count} ${reaction.count === 1 ? 'reaction' : 'reactions'}${reaction.reacted_by_me ? ', including yours' : ''}`} disabled={!canSend} onclick={() => react(reaction.emoji)}>{reaction.emoji + ' ' + reaction.count}</button>{/each}</div>{/if}</div>
