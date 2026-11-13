<script lang="ts">
  import {formFields} from '../dom.ts'
  import type {WalletView} from './state.svelte.ts'

  let {wallet: w}: {wallet: WalletView} = $props()
  const view = $derived(w.view)
  const hasShare = !!w.options.onShareMessage

  const submit = (action: (form: HTMLFormElement) => void) => (event: SubmitEvent) => { event.preventDefault(); action(event.currentTarget as HTMLFormElement) }
  // Passwords go straight from the field to the wallet and never into component state.
  const unlock = submit(form => { const fields = formFields(form), password = fields.password.value; fields.password.value = ''; void w.unlock(password) })
  const backup = submit(form => { const fields = formFields(form), password = fields.password.value, repeat = fields.repeat.value; fields.password.value = fields.repeat.value = ''; void w.backup(password, repeat) })
  const restore = submit(form => { const fields = formFields(form), file = fields.backup.files[0], password = fields.password.value; fields.password.value = ''; void w.importBackup(file, password, () => form.reset()) })
</script>

<button class="dialog-close icon-button" id="wallet-close" aria-label="Close wallet" onclick={() => w.dialog.close()}>×</button><h2>Wallet</h2><p id="wallet-error" class="error" role="alert">{w.errorText}</p><p id="wallet-status" class="small muted" role="status">{w.statusNote || view.status}</p>
<div id="wallet-disabled" hidden={w.previewNotice || view.ready || view.locked}>
  <p id="wallet-enable-intro" class="muted">{w.enableIntro}</p>
  <form id="wallet-enable" onsubmit={submit(() => void w.enable())}><label>Mint<input name="mint" type="url" autocomplete="off" required bind:value={w.enableMint} readonly={w.enableReadOnly}></label><p class="small muted">Your balance is held by this mint. Your wallet stays on this device.</p><button class="button primary" disabled={view.disabled}>Enable wallet</button></form>
  <details class="wallet-settings"><summary>Restore a backup</summary><form id="wallet-import" onsubmit={restore}><label>Backup file<input name="backup" type="file" accept="application/json,.json" required></label><label>Backup password<input name="password" type="password" autocomplete="off" required></label><label class="wallet-check"><input name="stopped" type="checkbox" required> I have stopped using the original wallet.</label><p class="small muted">Use your newest backup. An older copy can miss later payments.</p><button class="button secondary" disabled={view.disabled}>Restore wallet</button></form></details>
</div>
<form id="wallet-unlock" hidden={!view.locked} onsubmit={unlock}><label id="wallet-password-label" hidden={view.passwordHidden}>Password<input name="password" type="password" autocomplete="current-password"></label><button class="button primary" disabled={view.disabled}>Unlock wallet</button></form>
<div id="wallet-ready" hidden={w.previewNotice || !view.ready}>
  <section id="wallet-order-payment" class="wallet-flow" hidden={!view.order}>
    <h3>Pay order</h3><p id="wallet-order-title">{view.order?.title ?? ''}</p><p id="wallet-order-amount">{view.order?.amount ?? ''}</p><p id="wallet-order-mint" class="small muted">{view.order?.mint ?? ''}</p><p id="wallet-order-fee" class="small muted">{view.order?.fee ?? ''}</p>
    <button id="wallet-order-pay" class="button primary" disabled={view.disabled} onclick={() => void w.payCurrentOrder()}>{view.order?.action ?? 'Review payment'}</button><button id="wallet-order-back" class="text-button" onclick={() => w.backToOrder()}>Back to order</button>
  </section>
  <p id="wallet-test-money" class="small muted" hidden={!view.testMoney}>Test money · no bitcoin value</p>
  <label class="sr-only" for="wallet-mint">Mint</label><select id="wallet-mint" aria-label="Wallet mint" value={view.selectedMint} onchange={event => void w.selectMint(event.currentTarget.value)}>{#each view.mints as mint}<option value={mint.url}>{mint.label}</option>{/each}</select>
  <div class="wallet-balance"><strong id="wallet-balance">{view.balance}</strong><span id="wallet-estimate" class="muted">{view.estimate}</span></div>
  <div class="wallet-actions"><button id="wallet-receive-tab" class="button primary" onclick={() => w.toggleReceive()}>Receive</button><button id="wallet-send-tab" class="button secondary" onclick={() => w.toggleSend()}>Send</button></div>
  <div id="wallet-pending">{#each view.pending as row}<div class="wallet-pending-row"><div><span>{row.label}</span>{#if row.item.error}<p class="small muted">{row.item.error}</p>{/if}</div><button class="text-button" onclick={() => void w.recover(row.item.id)}>Check status</button>{#if row.reclaim}<button class="text-button" onclick={() => void w.cancelPayment(row.item.id)}>Reclaim</button>{/if}</div>{/each}</div>
<section id="wallet-receive" class="wallet-flow" hidden={!w.receiveShown}>
  <h3>Receive</h3>
  <div class="segments">{#each [['lightning', 'Lightning'], ['cashu', 'Cashu']] as [mode, label]}<button data-receive={mode} class:selected={w.receiveMode === mode} aria-pressed={w.receiveMode === mode} onclick={() => w.setReceiveMode(mode)}>{label}</button>{/each}</div>
  <form id="wallet-invoice-form" hidden={w.invoiceFormHidden} onsubmit={submit(() => void w.createInvoice())}><label>Amount in sats<input name="amount" inputmode="numeric" pattern="[0-9]+" required bind:value={w.invoiceAmount}></label><button class="button primary" disabled={view.disabled}>Create invoice</button></form>
  <div id="wallet-invoice" hidden={!w.invoiceShown}>
    <img id="wallet-invoice-qr" class="wallet-invoice-qr" alt="Lightning invoice QR code" hidden={!w.invoicePresented} src={w.invoiceImage || undefined}>
    <label>Lightning invoice<textarea id="wallet-invoice-text" readonly rows="3" value={view.invoice?.request ?? ''}></textarea></label>
    <div class="wallet-actions"><a id="wallet-open-invoice" class="button primary" hidden={!w.invoicePresented} href={w.invoiceUri || undefined}>Open in wallet</a><button id="wallet-copy-invoice" class="button secondary" onclick={() => void w.copy(view.invoice?.request ?? '')}>Copy invoice</button><button id="wallet-check-invoice" class="text-button" disabled={view.disabled} onclick={() => void w.checkInvoice()}>Check payment</button></div>
    <p id="wallet-invoice-state" class="small muted" role="status">{view.invoice?.state ?? ''}</p>
  </div>
  <div id="wallet-saved-invoices">{#each view.invoices as row}<button class="text-button" onclick={() => w.openSavedInvoice(row.item.id)}>{row.label}</button>{/each}</div>
  <form id="wallet-receive-form" hidden={w.receiveFormHidden} oninput={() => w.receiveEdited()} onsubmit={submit(() => void w.reviewReceive())}>
    <label>Cashu token<textarea name="token" rows="3" autocomplete="off" spellcheck="false" required bind:value={w.receiveText}></textarea></label><button class="button primary" disabled={view.disabled}>Review token</button>
    <div id="wallet-receive-preview" hidden={!w.receivePreviewShown}><p id="wallet-receive-summary">{w.receiveSummary}</p><button id="wallet-receive-confirm" type="button" class="button primary" hidden={w.receiveConfirmHidden} disabled={view.disabled} onclick={() => void w.confirmReceive()}>{w.receiveConfirmLabel}</button></div>
  </form>
</section>
<section id="wallet-send" class="wallet-flow" hidden={!w.sendShown}>
  <h3>Send</h3>
  <div class="segments">{#each [['cashu', 'Cashu'], ['lightning', 'Lightning']] as [mode, label]}<button data-send={mode} class:selected={w.sendMode === mode} aria-pressed={w.sendMode === mode} onclick={() => w.setSendMode(mode)}>{label}</button>{/each}</div>
  <form id="wallet-send-form" hidden={w.sendMode !== 'cashu'} oninput={() => w.clearQuote()} onsubmit={submit(() => void w.reviewSend())}><label>Amount in sats<input name="amount" inputmode="numeric" pattern="[0-9]+" required bind:value={w.sendAmount}></label><button class="button primary" disabled={view.disabled}>Review transfer</button></form>
  <form id="wallet-pay-form" hidden={w.sendMode !== 'lightning'} oninput={() => w.clearQuote()} onsubmit={submit(() => void w.reviewPayment())}><label>Lightning invoice<textarea name="invoice" rows="3" autocomplete="off" spellcheck="false" required bind:value={w.payInvoice}></textarea></label><button class="button primary" disabled={view.disabled}>Review payment</button></form>
  <div id="wallet-send-preview" hidden={!w.sendPreviewShown}><p id="wallet-send-summary">{w.sendSummary}</p><button id="wallet-send-confirm" class="button primary" disabled={view.disabled} onclick={() => void w.confirmSend()}>{w.sendConfirmLabel}</button></div>
  <div id="wallet-token" hidden={!w.tokenShown}>
    <label>Cashu token<textarea id="wallet-token-text" readonly rows="3" value={w.tokenText}></textarea></label><p class="small muted">Anyone with this token can redeem it.</p>
    <div class="wallet-actions"><button id="wallet-copy-token" class="button primary" onclick={() => void w.copy(w.tokenText)}>Copy token</button><button id="wallet-share-token" class="button secondary" hidden={!hasShare} onclick={() => w.shareToken()}>Add to message</button></div>
  </div>
</section>
<section id="wallet-reclaim" class="wallet-flow" hidden={!w.reclaimShown}>
  <h3>Reclaim payment</h3><p id="wallet-reclaim-summary">{w.reclaimSummary}</p><p class="small muted">If it is still unspent, this returns the funds to your wallet and invalidates the token you shared.</p>
  <div class="wallet-actions"><button id="wallet-reclaim-confirm" class="button primary" disabled={view.disabled} onclick={() => void w.confirmReclaim()}>Reclaim payment</button><button id="wallet-reclaim-cancel" class="button secondary" onclick={() => w.cancelReclaim()}>Cancel</button></div>
</section>
<div class="wallet-history">
  <div class="wallet-history-head"><h3>Activity</h3><button id="wallet-refresh" class="text-button" disabled={view.disabled} onclick={() => void w.refresh()}>Refresh</button></div>
  <div id="wallet-history">{#each view.history as row}<div class="wallet-history-row"><div><strong>{row.label}</strong><span class="small muted">{row.detail}</span></div><div class="wallet-history-amount">{row.amount}{#if row.showToken}<button class="text-button" onclick={() => void w.showSavedToken(row.item.id)}>Show token</button>{/if}{#if row.reclaim}<button class="text-button" onclick={() => void w.reviewReclaim(row.item.id)}>Reclaim payment</button>{/if}{#if row.share}<button class="text-button" type="button" aria-label="Share payment note" onclick={() => w.sharePayment(row.item)}>Share</button>{/if}</div></div>{:else}{#if view.rendered}<p class="muted small">No payments yet.</p>{/if}{/each}</div>
</div>
<details class="wallet-settings">
  <summary>Wallet settings</summary><p class="small muted">Back up before adding funds. Messages and your Nostr profile do not back up this wallet.</p>
  <form id="wallet-backup" onsubmit={backup}><label>Backup password<input name="password" type="password" minlength="12" autocomplete="new-password" required></label><label>Repeat password<input name="repeat" type="password" minlength="12" autocomplete="new-password" required></label><button class="button secondary" disabled={view.disabled}>Download encrypted backup</button></form>
  <form id="wallet-add-mint" hidden={w.addMintHidden} onsubmit={submit(() => void w.addMint())}><label>Add a mint<input name="mint" type="url" placeholder="https://…" autocomplete="off" required bind:value={w.addMintUrl}></label><button class="button secondary" disabled={view.disabled}>Add mint</button></form>
  <button id="wallet-lock" class="text-button" onclick={() => void w.lock()}>Lock wallet</button>
</details>
</div>
