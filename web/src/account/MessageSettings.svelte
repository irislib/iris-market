<script lang="ts">
  import type {AccountController} from './controller.svelte.ts'
  let {c}: {c: AccountController} = $props()
  const view = $derived(c.accountView)
  const receipts = [['delivered', 'Send delivery receipts'], ['seen', 'Send read receipts']] as const
</script>

<details class="settings-section"><summary>Messages</summary>{#each receipts as [key, title] (key)}<label class="checkbox-label">{title}<input type="checkbox" checked={view.receipts[key]} disabled={view.receiptsDisabled} onchange={e => c.setReceipt(key, e.currentTarget)}></label>{/each}<button class="button secondary" type="button" disabled={view.retentionDisabled} onclick={() => c.editRetention()}>{view.retentionText}</button><p class="error small" role="alert">{c.receiptError}</p><p class="small muted">Let people know when their messages reach you or are visible on your screen. Saved per profile on this device.</p></details>
