import {element as el} from './dom.ts';
import {durationLabel, validSeconds, type Retention} from './messaging/retention.ts';

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

type TimerEditor = {policy: Retention; save: (policy: Retention) => Promise<void>}
  | {seconds: number|null; save: (seconds: number|null) => Promise<void>};

export function editChatTimer(config: TimerEditor) {
  const local = 'policy' in config;
  const name = local ? 'Message retention' : 'Conversation timer';
  const dialog = el('dialog'), form = el('form');
  dialog.className = 'composer-dialog chat-timer-dialog';
  dialog.setAttribute('aria-label', name);

  const select = el('select');
  select.setAttribute('aria-label', local ? 'History on this device' : 'Shared timer');
  const choices = local
    ? [['follow', 'Follow the conversation timer'], ['keep', 'Keep all messages on this device'], ['expire', 'Delete all messages on this device after…']]
    : [['off', 'Off'], ['expire', 'Expire new messages after…']];
  for (const [value, label] of choices) select.append(new Option(label, value));
  select.value = local ? config.policy.mode : config.seconds ? 'expire' : 'off';

  const duration = el('div', undefined, 'chat-timer-duration');
  const input = el('input'), unit = el('select');
  input.type = 'number'; input.min = '1'; input.step = '1';
  input.setAttribute('aria-label', 'Duration');
  unit.setAttribute('aria-label', 'Duration unit');
  const units = [['Days', 86400], ['Hours', 3600], ['Minutes', 60], ['Seconds', 1]] as const;
  for (const [label, seconds] of units) unit.append(new Option(label, String(seconds)));
  const current = local ? (config.policy.mode === 'expire' ? config.policy.seconds : null) : config.seconds;
  const base = current ? units.find(([,n]) => current % n === 0)[1] : 86400;
  unit.value = String(base); input.value = String(current ? current/base : 1);
  duration.append(input, unit);
  function toggleDuration() {
    duration.hidden = select.value !== 'expire';
    input.required = !duration.hidden;
  }
  select.onchange = toggleDuration;
  toggleDuration();

  const copy = local
    ? 'Applies to all sent and received messages in every chat for this profile on this device. Deleted messages cannot be restored.'
    : 'This timer applies to new messages for both participants. Each person can keep all messages or choose a different duration on their own device.';
  const error = el('p', '', 'error small'), actions = el('div', undefined, 'account-actions');
  const save = el('button', 'Save', 'button primary'), cancel = el('button', 'Cancel', 'button secondary');
  error.setAttribute('role','alert');
  cancel.type = 'button'; cancel.onclick = () => dialog.close();
  actions.append(save, cancel);
  form.append(el('h2', name), el('p', copy, 'small muted'), select, duration, error, actions);
  dialog.append(form); document.body.append(dialog);
  dialog.onclose = () => dialog.remove();
  dialog.showModal();

  form.onsubmit = async event => {
    event.preventDefault();
    const seconds = Number(input.value) * Number(unit.value);
    if (select.value === 'expire' && (!Number.isInteger(Number(input.value)) || !validSeconds(seconds))) {
      error.textContent = 'Enter a positive whole duration.';
      return;
    }
    save.disabled = true;
    try {
      if ('policy' in config) {
        await config.save(select.value === 'expire' ? {mode:'expire',seconds} : {mode:select.value as 'keep'|'follow'});
      } else {
        await config.save(select.value === 'expire' ? seconds : null);
      }
      dialog.close();
    } catch (cause) {
      error.textContent = cause.message;
      save.disabled = false;
    }
  };
}
