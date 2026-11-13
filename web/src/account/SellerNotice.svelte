<script lang="ts">
  import {noticeMessage, type merchantNotices} from '../messaging/merchant-notice.ts'

  let {merchant, notices, stillEligible}: {merchant: string; notices: Pick<ReturnType<typeof merchantNotices>, 'status' | 'queue'>; stillEligible: () => boolean} = $props()
  let root: HTMLElement
  let status = $state<string | undefined>()
  let disabled = $state(true)
  let feedback = $state('')
  let revision = 0

  export function show(next: string) {
    revision++
    status = next
    disabled = next !== 'available'
    if (next === 'queued') setTimeout(() => { if (root.isConnected) void notices.status(merchant).then(show).catch(() => {}) }, 2000)
    feedback = next === 'sent' ? 'Notice accepted by the seller’s inbox relay.' : next === 'locked' ? 'Unlock your profile to save a notice in its private history.' : next === 'no-inbox' ? 'This seller hasn’t published an inbox for anonymous notices.' : next === 'queued' ? 'Anonymous notice queued.' : ''
  }
  const initial = revision
  void notices.status(merchant).then(s => { if (revision === initial) show(s) }).catch(() => {})

  async function notify() {
    if (disabled) return
    if (!stillEligible()) { show('unavailable'); return }
    disabled = true
    try { show(await notices.queue(merchant)) }
    catch { feedback = 'Could not save the notice. Try again.'; disabled = false }
  }
</script>

<div class="seller-notice" bind:this={root} hidden={status === undefined || status === 'unavailable'}><button class="button secondary" type="button" hidden={status !== undefined && !['available', 'no-inbox', 'locked'].includes(status)} {disabled} onclick={notify}>Notify seller anonymously</button><p class="small muted" hidden={status !== undefined && status !== 'available'}>{'Sends “' + noticeMessage + '”'}</p><p class="small muted" role="status">{feedback}</p></div>
