<script lang="ts">
  import type {formatPrice} from '../currency.ts'

  type Props = {quote?: string; info: ReturnType<typeof formatPrice>; className: string}
  let {quote, info, className}: Props = $props()
  const detail = $derived(className === 'detail-price')
  const source = $derived.by(() => {
    if (quote || !info.source) return ''
    const when = new Intl.DateTimeFormat(undefined, {dateStyle: info.stale ? 'medium' : undefined, timeStyle: 'short'}).format(info.updatedAt * 1000)
    return `${info.source} · ${info.stale ? 'Last known' : 'Retrieved'} ${when}`
  })
</script>

{#if quote}
  <p class={className}>{quote}</p>
{:else}
  <p class={className} title={source || undefined}><span>{info.primary}</span>{#if detail && info.original}<small class="original-price">{info.original}</small>{/if}{#if detail && source}<small class="original-price">{source}</small>{/if}</p>
{/if}
