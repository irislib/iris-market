<script lang="ts">
  import type {SocialConnection} from '../profiles.ts'
  let {relation}: {relation?: SocialConnection} = $props()
  const label = $derived(relation?.badge && relation.distance !== null
    ? `${relation.description} · ${relation.distance} ${relation.distance === 1 ? 'step' : 'steps'} from the network root. Based on loaded public follow lists.`
    : '')
</script>

<!-- Relationship evidence, not an identity or seller-verification mark. -->
{#if label}<span class="relationship-badge relationship-{relation.badge}" title={label} aria-label={label} role="img">✓</span>{/if}
