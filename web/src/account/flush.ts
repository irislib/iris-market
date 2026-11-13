import {flushSync} from 'svelte';

/** Apply pending updates now so callers can read the DOM; inside an effect Svelte flushes them itself. */
export function flushNow() {
  try { flushSync(); }
  catch (error) { if (!String((error as Error)?.message).includes('flush_sync_in_effect')) throw error; }
}
