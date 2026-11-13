<script lang="ts">
  import {onMount} from 'svelte'
  import {validSeconds} from '../messaging/retention.ts'
  import type {TimerEditor} from '../chat-timers-ui.ts'

  let {config, onclose}: {config: TimerEditor; onclose: () => void} = $props()
  // The editor is opened for one config and removed when it closes.
  const initial = config
  const local = 'policy' in initial
  const name = local ? 'Message retention' : 'Conversation timer'
  const choices = local
    ? [['follow', 'Follow the conversation timer'], ['keep', 'Keep all messages on this device'], ['expire', 'Delete all messages on this device after…']]
    : [['off', 'Off'], ['expire', 'Expire new messages after…']]
  const units = [['Days', 86400], ['Hours', 3600], ['Minutes', 60], ['Seconds', 1]] as const
  const current = 'policy' in initial ? (initial.policy.mode === 'expire' ? initial.policy.seconds : null) : initial.seconds
  const base = current ? units.find(([, n]) => current % n === 0)[1] : 86400
  const copy = local
    ? 'Applies to all sent and received messages in every chat for this profile on this device. Deleted messages cannot be restored.'
    : 'This timer applies to new messages for both participants. Each person can keep all messages or choose a different duration on their own device.'

  let mode = $state<string>('policy' in initial ? initial.policy.mode : initial.seconds ? 'expire' : 'off')
  let amount = $state<number | null>(current ? current / base : 1)
  let unit = $state(String(base))
  let error = $state('')
  let saving = $state(false)
  let dialog: HTMLDialogElement

  onMount(() => dialog.showModal())

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    const seconds = Number(amount) * Number(unit)
    if (mode === 'expire' && (!Number.isInteger(Number(amount)) || !validSeconds(seconds))) { error = 'Enter a positive whole duration.'; return }
    saving = true
    try {
      if ('policy' in initial) await initial.save(mode === 'expire' ? {mode: 'expire', seconds} : {mode: mode as 'keep' | 'follow'})
      else await initial.save(mode === 'expire' ? seconds : null)
      dialog.close()
    } catch (cause) { error = cause.message; saving = false }
  }
</script>

<dialog bind:this={dialog} class="composer-dialog chat-timer-dialog" aria-label={name} {onclose}><form onsubmit={submit}><h2>{name}</h2><p class="small muted">{copy}</p><select value={mode} onchange={e => mode = e.currentTarget.value} aria-label={local ? 'History on this device' : 'Shared timer'}>{#each choices as [value, label] (value)}<option {value}>{label}</option>{/each}</select><div class="chat-timer-duration" hidden={mode !== 'expire'}><input type="number" min="1" step="1" bind:value={amount} required={mode === 'expire'} aria-label="Duration"><select value={unit} onchange={e => unit = e.currentTarget.value} aria-label="Duration unit">{#each units as [label, seconds] (seconds)}<option value={String(seconds)}>{label}</option>{/each}</select></div><p class="error small" role="alert">{error}</p><div class="account-actions"><button class="button primary" disabled={saving}>Save</button><button class="button secondary" type="button" onclick={() => dialog.close()}>Cancel</button></div></form></dialog>
