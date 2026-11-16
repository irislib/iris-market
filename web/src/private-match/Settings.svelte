<script lang="ts">
  import type {PrivateMatchState} from './state.svelte.ts'
  let {matches}: {matches: PrivateMatchState} = $props()
</script>

<details class="settings-section">
  <summary>Private matching</summary>
  <label class="checkbox-label"><input type="checkbox" checked={!!matches.view} disabled={!matches.ready}
    onchange={e => void matches.act({op: 'enable', enabled: e.currentTarget.checked})}>Find a match privately</label>
  <p>Exchange private offers and requests with a helper you choose. Open Private matches in Messages to return.</p>
  {#if !matches.view && matches.waiting}<p class="small">{matches.waiting === 1 ? 'Someone has' : `${matches.waiting} people have`} asked you to help find a match. Turn this on to see {matches.waiting === 1 ? 'it' : 'them'}.</p>{/if}
  <button hidden={!matches.view} onclick={() => matches.open()}>Open private matching</button>
  <p class="error">{matches.settingsError}</p>
</details>
