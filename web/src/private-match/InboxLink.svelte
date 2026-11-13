<script lang="ts">
  import type {PrivateMatchState} from './state.svelte.ts'
  let {matches}: {matches: PrivateMatchState} = $props()
</script>

<button class="button secondary match-inbox-link" hidden={!matches.view} onclick={() => matches.open()}>Private matches</button>
