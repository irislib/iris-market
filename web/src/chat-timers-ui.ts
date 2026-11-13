import {flushNow} from './account/flush.ts';
import {mount, unmount} from 'svelte';
import {durationLabel, type Retention} from './messaging/retention.ts';
import TimerDialog from './account/TimerDialog.svelte';

export function retentionLabel(policy: Retention) {
  if (policy.mode === 'keep') return 'Keep all messages on this device';
  if (policy.mode === 'expire') return 'Delete all messages on this device after ' + durationLabel(policy.seconds);
  return 'Follow the conversation timer';
}

export function localTimerDescription(policy: Retention) {
  if (policy.mode === 'keep') return 'This device keeps sent and received messages.';
  if (policy.mode === 'expire') return 'This device deletes sent and received messages after ' + durationLabel(policy.seconds) + '.';
  return 'This device follows the conversation timer.';
}

export type TimerEditor = {policy: Retention; save: (policy: Retention) => Promise<void>}
  | {seconds: number|null; save: (seconds: number|null) => Promise<void>};

/** Opens a modal editor; it removes itself when closed. */
export function editChatTimer(config: TimerEditor) {
  const view = mount(TimerDialog, {target: document.body, props: {config, onclose: () => { void unmount(view); }}});
  flushNow();
}
