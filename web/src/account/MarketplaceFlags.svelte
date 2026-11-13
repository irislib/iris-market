<script lang="ts">
  import {marketplaceToolEnabled, type MarketplaceTool} from '../marketplace-flags.ts'

  let {onchange}: {onchange: (id: MarketplaceTool, enabled: boolean) => string} = $props()
  const tools = [['escrow', 'Escrow', 'Agree on a third person to help settle a payment.']] as const
  let version = $state(0)
  let error = $state<string | undefined>()
  const enabled = (id: MarketplaceTool) => { void version; return marketplaceToolEnabled(id) }

  /** Settings live in localStorage, outside Svelte; read them again. */
  export function refresh() { version++ }
</script>

<details class="settings-section"><summary>Optional marketplace tools</summary>{#each tools as [id, title, detail] (id)}<label class="checkbox-label"><input type="checkbox" checked={enabled(id)} onchange={e => { error = onchange(id, e.currentTarget.checked); e.currentTarget.checked = enabled(id) }}>{title}</label><p class="small muted">{detail}</p>{/each}<p class="error small" role="alert">{error}</p></details>
