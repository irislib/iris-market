<script lang="ts">
  let {url, onToast}: {url: string; onToast: (message: string) => void} = $props()

  const canShare = typeof navigator.share === 'function' && (!navigator.canShare || navigator.canShare({url}))
  let share: HTMLButtonElement = $state()
  let choices: HTMLDivElement = $state()
  // A property, not an attribute: the popover needs no id.
  $effect(() => { if (share && choices) share.popoverTargetElement = choices })

  async function copyLink() {
    try { await navigator.clipboard.writeText(url); onToast('Link copied') }
    catch { onToast('Copy the address from your browser') }
  }
  async function send() {
    choices.hidePopover()
    try { await navigator.share({url}) }
    catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) onToast('Could not share this listing') }
  }
  function place(event: ToggleEvent) {
    if (event.newState !== 'open') return
    const rect = share.getBoundingClientRect()
    choices.style.left = Math.max(8, Math.min(rect.left, innerWidth - choices.offsetWidth - 8)) + 'px'
    choices.style.top = (rect.bottom + 6 + choices.offsetHeight <= innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - choices.offsetHeight - 6)) + 'px'
  }
  // The property, not Svelte's autofocus attribute, which would focus on mount.
  const autofocus = (button: HTMLButtonElement) => { button.autofocus = true }
</script>

{#if canShare}
  <button bind:this={share} class="button secondary listing-share" type="button">Share</button>
  <div bind:this={choices} class="listing-share-choices" popover="auto" role="group" aria-label="Share listing" ontoggle={place}>
    <button use:autofocus onclick={() => { choices.hidePopover(); void copyLink() }}>Copy link</button>
    <button onclick={send}>Share via…</button>
  </div>
{:else}
  <button bind:this={share} class="button secondary listing-share" type="button" onclick={copyLink}>Share</button>
{/if}
