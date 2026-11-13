<script lang="ts">
  import {onMount} from 'svelte'
  import {marketplaceToolEnabled} from '../marketplace-flags.ts'
  import type {EscrowOffer} from '../escrow-offer.ts'

  let {form}: {form: HTMLFormElement} = $props()
  let edit = $state(false)
  let editingOffer = $state.raw<EscrowOffer | undefined>()
  let protect = $state(false)
  let trade = $state('goods')
  let sats = $state('')
  let method = $state('bank_transfer')
  let version = $state(0)
  let tradeSelect: HTMLSelectElement

  const enabled = $derived.by(() => { void version; return marketplaceToolEnabled('escrow') && (!edit || editingOffer?.trade === 'bitcoin_fiat') })
  const bitcoin = $derived(edit ? editingOffer?.trade === 'bitcoin_fiat' : enabled && protect && trade === 'bitcoin_fiat')

  /** Also re-applies what the composer changes directly: the shared price field and busy-disabled controls. */
  export function sync(editing = edit) {
    edit = editing; version++
    const price = form.elements.namedItem('price') as HTMLInputElement
    const isBitcoin = editing ? editingOffer?.trade === 'bitcoin_fiat' : marketplaceToolEnabled('escrow') && protect && trade === 'bitcoin_fiat'
    price.parentElement.firstChild.textContent = isBitcoin ? 'Total fiat price' : 'Price'
    price.placeholder = isBitcoin ? '0.00' : 'Negotiable'
    if (tradeSelect) tradeSelect.disabled = editing
  }
  export function setEditingOffer(offer?: any) {
    editingOffer = offer; protect = !!offer; trade = offer?.trade ?? 'goods'
    sats = offer?.trade === 'bitcoin_fiat' ? String(offer.sats) : ''; method = offer?.method ?? 'bank_transfer'
  }
  export function choices() {
    const on = marketplaceToolEnabled('escrow') && (!edit || editingOffer?.trade === 'bitcoin_fiat') && protect
    return {escrow: on ? (trade === 'goods' ? {trade: 'goods'} : {trade: 'bitcoin_fiat', sats: Number(sats), method}) : undefined}
  }
  onMount(() => {
    const changed = () => sync()
    window.addEventListener('market-tools-change', changed)
    return () => window.removeEventListener('market-tools-change', changed)
  })
  // Direct listeners: this component sits inside the composer's own Svelte form, so it avoids a second delegated root there.
  const onChange = (node: HTMLElement, handler: (event: Event) => void) => {
    node.addEventListener('change', handler)
    return {destroy() { node.removeEventListener('change', handler) }}
  }
  const onInput = (node: HTMLElement, handler: (event: Event) => void) => {
    node.addEventListener('input', handler)
    return {destroy() { node.removeEventListener('input', handler) }}
  }
  function tradeChanged() {
    if (trade === 'bitcoin_fiat' && !edit) {
      const expiry = form.elements.namedItem('expiration') as HTMLSelectElement
      if (expiry && !expiry.value) expiry.value = '1w'
    }
    sync()
  }
</script>

<fieldset class="post-trade-tools" hidden={!enabled}><legend>Trade options</legend><label class="checkbox-label" hidden={!enabled || edit}><input type="checkbox" checked={protect} use:onChange={e => { protect = (e.currentTarget as HTMLInputElement).checked; sync() }}>Allow escrow on this listing</label><p class="small muted" hidden={!enabled || edit || !protect}>The other trader proposes a provider. You can accept or decline each request.</p><label hidden={!enabled || !protect}>Trade<select bind:this={tradeSelect} value={trade} use:onChange={e => { trade = (e.currentTarget as HTMLSelectElement).value; tradeChanged() }}><option value="goods">Goods or services</option><option value="bitcoin_fiat">Bitcoin for fiat</option></select></label><label hidden={!enabled || !bitcoin}>Bitcoin amount in sats<input value={sats} use:onInput={e => sats = (e.currentTarget as HTMLInputElement).value} inputmode="numeric" placeholder="100000"></label><label hidden={!enabled || !bitcoin}>Fiat payment method<select value={method} use:onChange={e => method = (e.currentTarget as HTMLSelectElement).value}><option value="bank_transfer">Bank transfer</option><option value="cash">Cash in person</option></select></label></fieldset>
