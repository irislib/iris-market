import {element} from '../dom.ts'
import {DEFAULT_SUPPORTED_MINTS, configuredLocalTestMint, isTestMint, mintUnitLabel} from '../wallet/mints.ts'
import {lightningPresentation} from '../wallet/lightning-presentation.ts'
import {formatPaymentNote} from '../cashu-content.ts'
import type {OrderView} from '../orders.ts'
import type {Surface} from '../surface.ts'
import type {createCashuWallet} from '../wallet/client.ts'
import type {EscrowAction} from '../wallet/escrow.ts'

type WalletSnapshot = Partial<ReturnType<ReturnType<typeof createCashuWallet>['state']>>
type HistoryItem = WalletSnapshot['history'][number]

export interface WalletOptions {
  isPreview: () => boolean
  formatEstimate?: (amount: string) => string
  loadClient?: () => Promise<typeof import('../wallet/client.ts')>
  onShareMessage?: (text: string) => unknown
}

const escrowLabels = {funding: 'Escrow deposit', payout: 'Escrow payout', refund: 'Escrow refund'}
const typeLabels = {send: 'Sent', receive: 'Received', mint: 'Received', melt: 'Lightning payment', lightning: 'Lightning payment'}
const PREVIEW_NOTICE = 'Switch to the live market to use your wallet.'
export const sats = (value, mint = '') => new Intl.NumberFormat().format(BigInt(value || '0')) + ' ' + mintUnitLabel(mint)
export const mintName = url => { try { return new URL(url).hostname } catch { return 'Mint' } }

/**
 * Wallet screen state. The client snapshot and flow bookkeeping are plain fields read
 * through `version`, bumped by render() exactly where the old DOM code re-rendered;
 * fields the old code changed directly on the DOM are reactive.
 */
export class WalletView {
  readonly dialog: Surface
  readonly options: WalletOptions
  readonly developerMint = configuredLocalTestMint()
  readonly supportedMints = this.developerMint ? [...DEFAULT_SUPPORTED_MINTS, this.developerMint] : DEFAULT_SUPPORTED_MINTS

  version = $state(0)
  errorText = $state('')
  statusNote = $state('')
  previewNotice = $state(false)
  enableIntro = $state('Send and receive bitcoin with Cashu.')
  enableMint = $state('')
  enableReadOnly = $state(false)
  addMintHidden = $state(false)
  addMintUrl = $state('')
  receiveShown = $state(false)
  sendShown = $state(false)
  receiveMode = $state('lightning')
  sendMode = $state('cashu')
  invoiceFormHidden = $state(false)
  receiveFormHidden = $state(true)
  invoiceShown = $state(false)
  invoiceAmount = $state('')
  invoiceImage = $state('')
  invoiceUri = $state('')
  invoicePresented = $state(false)
  receiveText = $state('')
  receivePreviewShown = $state(false)
  receiveSummary = $state('')
  receiveConfirmHidden = $state(false)
  receiveConfirmLabel = $state('Receive token')
  sendAmount = $state('')
  payInvoice = $state('')
  sendPreviewShown = $state(false)
  sendSummary = $state('')
  sendConfirmLabel = $state('Create token')
  tokenText = $state('')
  tokenShown = $state(false)
  reclaimShown = $state(false)
  reclaimSummary = $state('')

  client: any
  wallet: WalletSnapshot = {status: 'disabled', mints: [], history: [], pending: [], invoices: []}
  busy = false
  private loading: Promise<void> | null = null
  private paymentOrder: OrderView | undefined
  private paymentQuote: any
  private paymentSend: ((token: string) => Promise<void>) | undefined
  private paymentDone: (() => void) | undefined
  private receivedDone: (() => void) | undefined
  private sendQuote: any
  private receiveQuote: any
  private receiveToken = ''
  private invoiceId: string | undefined
  private polling = false
  private pendingToken = ''
  private walletRevision = 0
  private presentedInvoice = ''
  private reclaimQuote: {id: string; mint: string; amount: string; fee: string; received: string} | undefined

  constructor(dialog: Surface, options: WalletOptions) {
    this.dialog = dialog
    this.options = options
  }

  preferred(amount: string, mint: string) { return !isTestMint(mint) && this.options.formatEstimate?.(amount) || sats(amount, mint) }
  reviewedAmount(amount: string, mint: string) { const primary = this.preferred(amount, mint), exact = sats(amount, mint); return primary === exact ? exact : primary + ' (' + exact + ')' }
  error(cause) { this.errorText = cause?.message || String(cause) }

  private currentInvoice() {
    return this.wallet.status === 'ready' ? this.wallet.invoices?.find(item => item.id === this.invoiceId) : undefined
  }

  /** What the screen shows for the current snapshot. */
  view = $derived.by(() => {
    // Before the first render the screen shows its static markup, with no estimate.
    const rendered = this.version > 0
    const state = this.wallet, client = this.client, onShare = this.options.onShareMessage
    const ready = state.status === 'ready', locked = state.status === 'locked'
    const converted = rendered && !isTestMint(state.selectedMint || '') ? this.options.formatEstimate?.(state.balance || '0') || '' : ''
    const order = this.paymentOrder, payment = order?.payment
    const existing = payment && state.history?.find(item => item.id === 'order-payment:' + order.id + ':' + payment.mint + ':' + payment.amount)
    const amountOf = (item: {amount: string; mint?: string}) => this.preferred(item.amount, item.mint || state.selectedMint)
    return {
      ready, locked, rendered,
      passwordHidden: rendered && !state.password,
      balance: converted || sats(state.balance, state.selectedMint),
      estimate: converted ? sats(state.balance, state.selectedMint) : '',
      testMoney: isTestMint(state.selectedMint || ''),
      order: payment ? {
        title: order.items[0].title,
        amount: this.preferred(payment.amount, payment.mint),
        mint: mintName(payment.mint) + (isTestMint(payment.mint) ? ' · Test money' : ''),
        fee: existing ? 'Fee ' + this.reviewedAmount(existing.fee, payment.mint) : this.paymentQuote ? 'Fee up to ' + this.reviewedAmount(this.paymentQuote.fee, payment.mint) : '',
        action: existing ? 'Retry sending payment' : this.paymentQuote ? 'Pay ' + this.preferred(payment.amount, payment.mint) : 'Review payment',
      } : undefined,
      mints: (state.mints || []).map(mint => ({url: mint.url, label: mintName(mint.url) + (isTestMint(mint.url) ? ' · Test money' : '') + (mint.supported === false ? ' · Unavailable' : '')})),
      selectedMint: state.selectedMint || '',
      status: state.reviewRequired ? 'Refresh to check this restored wallet before spending.' : state.busy || this.busy ? 'Working…' : '',
      pending: (state.pending || []).map(item => ({
        item, label: (item.escrow ? escrowLabels[item.escrow] + ' · ' : '') + amountOf(item) + ' · Pending',
        reclaim: !item.escrow && item.canReclaim,
      })),
      history: (state.history || []).slice(0, 40).map(item => ({
        item,
        label: escrowLabels[item.escrow] || typeLabels[item.type] || 'Transfer',
        detail: new Date(item.createdAt > 1e12 ? item.createdAt : item.createdAt * 1000).toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) + ' · ' + (item.type === 'send' && item.state === 'cancelled' ? 'Reclaimed' : item.state),
        amount: amountOf(item),
        showToken: !item.escrow && item.type === 'send' && item.state === 'complete' && !!client?.getToken,
        reclaim: !item.escrow && item.canReclaim && !!client?.previewReclaimToken,
        share: !!onShare && !isTestMint(item.mint || state.selectedMint || '') && ['lightning', 'melt'].includes(item.type) && item.state === 'complete',
      })),
      invoices: (state.invoices || []).filter(item => item.state !== 'ISSUED').slice(-8).reverse().map(item => ({item, label: 'Invoice · ' + amountOf(item) + ' · ' + item.state})),
      invoice: this.currentInvoice(),
      disabled: this.busy || !!state.busy,
    }
  })

  /** Re-read the snapshot and apply the side effects the old render() had. */
  render() {
    const state = this.wallet, ready = state.status === 'ready'
    this.enableIntro = isTestMint(this.enableMint) ? 'Receive test money with Cashu. No bitcoin value.' : 'Send and receive bitcoin with Cashu.'
    if (!ready) {
      this.tokenText = ''; this.tokenShown = false; this.receiveText = ''; this.payInvoice = ''; this.receiveToken = ''
      this.receiveQuote = this.sendQuote = null; this.sendPreviewShown = false; this.receivePreviewShown = false
      this.reclaimQuote = undefined; this.reclaimShown = false
    }
    this.previewNotice = false
    this.statusNote = ''
    if (!this.invoiceId) this.invoiceId = state.invoices?.findLast(item => item.state !== 'ISSUED')?.id
    const invoice = this.currentInvoice()
    const invoiceOpen = invoice && !['issued', 'paid', 'expired'].includes(invoice.state.toLowerCase()) && (!invoice.expiresAt || invoice.expiresAt > Date.now() / 1000)
    const request = invoiceOpen && !isTestMint(invoice.mint) ? invoice.request : ''
    if (request !== this.presentedInvoice) {
      this.presentedInvoice = request
      const presentation = request ? lightningPresentation(request) : undefined
      this.invoicePresented = !!presentation; this.invoiceImage = presentation?.image || ''; this.invoiceUri = presentation?.uri || ''
    }
    this.invoiceShown = !!invoice
    this.version++
    if (ready && this.dialog.open && this.pendingToken) {
      this.receiveText = this.pendingToken; this.pendingToken = ''; this.receiveToken = ''; this.receiveQuote = null
      this.receivePreviewShown = false; this.receiveShown = true; this.sendShown = false; this.setReceiveMode('cashu')
    }
  }

  async run(task: () => unknown) {
    if (this.busy) return
    const revision = this.walletRevision
    this.busy = true; this.errorText = ''; this.render()
    try { return await task() } catch (cause) { if (revision === this.walletRevision && this.dialog.open) this.error(cause) } finally { this.busy = false; this.render() }
  }

  async load() {
    if (!this.loading) this.loading = (async () => {
      const module = await (this.options.loadClient ?? (() => import('../wallet/client.ts')))()
      this.enableMint = this.paymentOrder?.payment?.mint || this.developerMint || module.DEFAULT_MINT
      this.enableReadOnly = true; this.addMintHidden = true
      this.client = module.createCashuWallet({allowedMints: this.supportedMints, developerMint: this.developerMint, onChange: value => { this.wallet = value; this.render() }})
      await this.client.restore(); this.wallet = this.client.state(); this.render()
    })()
    try { await this.loading } catch (cause) { this.loading = null; this.error(cause) }
  }

  showToken(result, revision = this.walletRevision) {
    if (!this.dialog.open || this.wallet.status !== 'ready' || revision !== this.walletRevision) return
    const token = typeof result === 'string' ? result : result?.token
    if (!token) throw new Error('This token is not available.')
    this.tokenText = token; this.tokenShown = true
  }

  async shareMessage(text: string) {
    const share = this.options.onShareMessage
    if (!share || !this.dialog.open || this.wallet.status !== 'ready') return
    try { await share(text); this.dialog.hide() } catch (cause) { this.error(cause) }
  }

  async open() {
    if (!this.dialog.open) this.dialog.showModal()
    if (this.options.isPreview()) { this.previewNotice = true; this.statusNote = PREVIEW_NOTICE; return }
    await this.load(); this.render()
  }

  async openToken(token: string, onReceived?: () => void) {
    this.walletRevision++; this.receivedDone = onReceived; this.paymentOrder = undefined; this.paymentQuote = undefined
    if (this.options.isPreview()) throw new Error(PREVIEW_NOTICE)
    if (typeof token !== 'string' || token.length > 16000 || !/^cashu[AB][A-Za-z0-9_-]+={0,2}$/.test(token)) throw new Error('This Cashu token is invalid.')
    this.pendingToken = token
    const revision = this.walletRevision
    await this.open(); if (revision !== this.walletRevision || !this.dialog.open) return
    const {getTokenMetadata} = await import('@cashu/cashu-ts')
    const mint = getTokenMetadata(token).mint.replace(/\/+$/, '')
    if (revision !== this.walletRevision || !this.dialog.open) return
    if (this.wallet.status === 'disabled' && this.supportedMints.includes(mint)) this.enableMint = mint
    this.render()
  }

  async payOrder(order: OrderView, send: (token: string) => Promise<void>, onDone: () => void) {
    if (order.escrowTradeId || !order.payment || order.payment.status !== 'requested') return
    this.walletRevision++; this.paymentOrder = order; this.paymentQuote = undefined; this.paymentSend = send; this.paymentDone = onDone; this.receivedDone = undefined
    const revision = this.walletRevision
    await this.open(); if (revision !== this.walletRevision || !this.dialog.open) return
    this.enableMint = order.payment.mint; this.render()
  }

  backToOrder() { const done = this.paymentDone; this.dialog.hide(); done?.() }

  payCurrentOrder() {
    return this.run(async () => {
      const client = this.client, order = this.paymentOrder, payment = order?.payment, send = this.paymentSend, done = this.paymentDone, revision = this.walletRevision
      const active = () => this.dialog.open && revision === this.walletRevision && this.paymentOrder === order && this.wallet.status === 'ready'
      if (!payment || !send || !active()) return
      if (!this.supportedMints.includes(payment.mint)) throw new Error('This mint is not supported by this wallet.')
      const operationId = 'order-payment:' + order.id + ':' + payment.mint + ':' + payment.amount
      const previous = this.wallet.history?.find(item => item.id === operationId)
      let result
      if (previous) {
        if (previous.type !== 'send' || previous.mint !== payment.mint || previous.amount !== payment.amount) throw new Error('Saved payment does not match this order.')
        if (previous.state === 'cancelled') throw new Error('This payment was cancelled.')
        result = previous.state === 'complete' ? {token: await client.getToken(operationId)} : await client.recover(operationId)
        if (!result?.token) throw new Error('This payment is still pending. Check its status before retrying.')
      } else {
        if (!this.wallet.mints.some(mint => mint.url === payment.mint)) await client.addMint(payment.mint)
        if (!active()) return; await client.selectMint(payment.mint); if (!active()) return
        if (!this.paymentQuote) { const quote = await client.previewSend(payment.amount); if (active()) this.paymentQuote = quote; return }
        result = await client.send({amount: payment.amount, maxFee: this.paymentQuote.fee, idempotencyKey: operationId})
      }
      if (!active()) return; await send(result.token); if (!active()) return
      this.paymentOrder = undefined; this.paymentQuote = undefined; this.dialog.hide(); done?.()
    })
  }

  cancelReclaim() { this.reclaimQuote = undefined; this.reclaimShown = false }

  confirmReclaim() {
    return this.run(async () => {
      const quote = this.reclaimQuote, revision = this.walletRevision
      if (!quote || !this.dialog.open || this.wallet.status !== 'ready') return
      const result = await this.client.reclaimToken(quote.id, {maxFee: quote.fee})
      if (!this.dialog.open || revision !== this.walletRevision || this.reclaimQuote !== quote) return
      this.reclaimQuote = undefined; this.reclaimShown = false; this.statusNote = this.preferred(result.amount, quote.mint) + ' reclaimed'
    })
  }

  /** The surface's close event: forget every in-flight review and bearer token. */
  closed() {
    this.reclaimQuote = undefined; this.reclaimShown = false; this.walletRevision++
    this.paymentQuote = undefined; this.paymentOrder = undefined; this.paymentSend = undefined; this.paymentDone = undefined; this.receivedDone = undefined
    this.pendingToken = ''; this.receiveText = ''; this.payInvoice = ''; this.tokenText = ''; this.tokenShown = false
    this.receiveToken = ''; this.receiveQuote = this.sendQuote = null
  }

  enable() { return this.run(async () => { await this.client.enable({mintUrl: this.enableMint.trim()}); this.wallet = this.client.state(); this.render() }) }
  unlock(password: string) { return this.run(() => this.client.unlock(password)) }
  lock() { return this.run(() => { this.walletRevision++; this.pendingToken = ''; return this.client.lock() }) }

  selectMint(url: string) {
    return this.run(async () => {
      this.reclaimQuote = undefined; this.reclaimShown = false; this.walletRevision++; this.pendingToken = ''; this.paymentQuote = undefined
      this.sendQuote = this.receiveQuote = null; this.receiveToken = ''; this.invoiceId = undefined
      this.sendPreviewShown = false; this.receivePreviewShown = false; this.tokenText = ''; this.tokenShown = false
      await this.client.selectMint(url)
    })
  }

  toggleReceive() { this.receiveShown = !this.receiveShown; this.sendShown = false }
  toggleSend() { this.sendShown = !this.sendShown; this.receiveShown = false }

  setReceiveMode(mode: string) {
    const lightning = mode === 'lightning'
    this.invoiceFormHidden = !lightning; this.invoiceShown = lightning && !!this.invoiceId; this.receiveFormHidden = lightning
    this.receiveMode = mode
  }

  setSendMode(mode: string) { this.sendMode = mode; this.sendPreviewShown = false; this.sendQuote = null }

  createInvoice() {
    return this.run(async () => { const invoice = await this.client.createInvoice(this.invoiceAmount); this.invoiceId = invoice.id; this.wallet = this.client.state(); this.render() })
  }
  checkInvoice() { return this.run(() => this.client.checkInvoice(this.invoiceId)) }
  openSavedInvoice(id: string) { this.invoiceId = id; this.invoiceFormHidden = false; this.receiveFormHidden = true; this.render() }

  receiveEdited() { this.receiveQuote = null; this.receiveToken = ''; this.receivePreviewShown = false }

  reviewReceive() {
    return this.run(async () => {
      const revision = this.walletRevision, token = this.receiveText.trim(); this.receiveToken = token
      const quote = await this.client.previewReceive(token)
      if (!this.dialog.open || revision !== this.walletRevision || this.receiveText.trim() !== token) return
      const supported = this.supportedMints.includes(quote.mint)
      this.receiveQuote = quote
      this.receiveSummary = quote.unknownMint
        ? (supported ? 'Add ' + mintName(quote.mint) + (isTestMint(quote.mint) ? ' · Test money' : '') : 'This mint is not supported by this wallet.')
        : 'Receive ' + this.reviewedAmount(quote.received, quote.mint) + ' · ' + mintName(quote.mint) + (quote.fee !== '0' ? ' · Fee ' + this.reviewedAmount(quote.fee, quote.mint) : '')
      this.receiveConfirmHidden = !!quote.unknownMint && !supported
      this.receiveConfirmLabel = quote.unknownMint ? 'Add mint and review' : 'Receive token'
      this.receivePreviewShown = true
    })
  }

  confirmReceive() {
    return this.run(async () => {
      const client = this.client, revision = this.walletRevision, token = this.receiveToken, quote = this.receiveQuote, done = this.receivedDone
      const active = () => this.dialog.open && revision === this.walletRevision && this.wallet.status === 'ready' && this.receiveText.trim() === token
      if (!quote || !active()) throw new Error('Review a token first.')
      if (quote.unknownMint) {
        if (!this.supportedMints.includes(quote.mint)) throw new Error('This mint is not supported by this wallet.')
        await client.addMint(quote.mint); if (!active()) return
        const next = await client.previewReceive(token); if (!active()) return
        this.receiveQuote = next
        this.receiveSummary = 'Receive ' + this.reviewedAmount(next.received, next.mint) + ' · Fee ' + this.reviewedAmount(next.fee, next.mint)
        this.receiveConfirmLabel = 'Receive token'
        return
      }
      await client.receive(token); if (!active()) return
      this.receiveToken = ''; this.receiveQuote = null; this.receiveText = ''; this.receivePreviewShown = false; this.receiveShown = false; this.receivedDone = undefined
      if (done) { this.dialog.hide(); done() }
    })
  }

  clearQuote() { this.sendQuote = null; this.sendPreviewShown = false }

  private showQuote(quote) {
    const mint = this.wallet.selectedMint
    this.sendQuote = quote
    this.sendSummary = this.reviewedAmount(quote.amount, mint) + ' · Fee up to ' + this.reviewedAmount(quote.fee || '0', mint)
    this.sendConfirmLabel = this.sendMode === 'cashu' ? 'Create token' : 'Pay invoice'
    this.sendPreviewShown = true
  }

  reviewSend() {
    return this.run(async () => {
      const revision = this.walletRevision, amount = this.sendAmount, quote = await this.client.previewSend(amount)
      if (this.dialog.open && revision === this.walletRevision && this.sendAmount === amount) this.showQuote(quote)
    })
  }

  reviewPayment() {
    return this.run(async () => {
      const revision = this.walletRevision, invoice = this.payInvoice.trim(), quote = await this.client.previewLightning(invoice)
      if (this.dialog.open && revision === this.walletRevision && this.payInvoice.trim() === invoice) this.showQuote(quote)
    })
  }

  confirmSend() {
    return this.run(async () => {
      const quote = this.sendQuote
      if (!quote) throw new Error('Review this transfer first.')
      if (this.sendMode === 'cashu') { const revision = this.walletRevision; this.showToken(await this.client.send({amount: quote.amount, maxFee: quote.fee || '0'}), revision) }
      else await this.client.payLightning({quoteId: quote.quoteId, maxFee: quote.fee})
      this.sendQuote = null; this.sendPreviewShown = false
    })
  }

  copy(text: string) {
    return navigator.clipboard.writeText(text).then(() => { this.statusNote = 'Copied' }).catch(() => this.error(new Error('Copy the text from the field.')))
  }
  shareToken() { const token = this.tokenText; if (token) void this.shareMessage(token) }
  sharePayment(item: HistoryItem) { void this.shareMessage(formatPaymentNote(item)) }
  refresh() { return this.run(() => this.client.refresh()) }
  addMint() { return this.run(() => this.client.addMint(this.addMintUrl.trim())) }
  recover(id: string) { return this.run(() => this.client.recover(id)) }
  cancelPayment(id: string) { return this.run(() => this.client.cancelPayment(id)) }

  showSavedToken(id: string) {
    return this.run(async () => {
      const revision = this.walletRevision
      this.showToken(await this.client.getToken(id), revision)
      if (revision === this.walletRevision && this.dialog.open) this.sendShown = true
    })
  }

  reviewReclaim(id: string) {
    return this.run(async () => {
      const revision = this.walletRevision, quote = await this.client.previewReclaimToken(id)
      if (!this.dialog.open || revision !== this.walletRevision) return
      this.reclaimQuote = {...quote, id}
      this.reclaimSummary = this.reviewedAmount(quote.received, quote.mint) + ' to return · Fee ' + this.reviewedAmount(quote.fee, quote.mint)
      this.reclaimShown = true
    })
  }

  backup(password: string, repeat: string) {
    return this.run(async () => {
      if (password !== repeat) throw new Error('The passwords do not match.')
      const backup = await this.client.exportEncryptedBackup(password)
      const url = URL.createObjectURL(new Blob([typeof backup === 'string' ? backup : JSON.stringify(backup)], {type: 'application/json'}))
      const link = element('a'); link.href = url; link.download = 'iris-market-wallet-' + new Date().toISOString().slice(0, 10) + '.json'; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }

  importBackup(file: File | undefined, password: string, done: () => void) {
    return this.run(async () => {
      if (!file || file.size > 12 * 1024 * 1024) throw new Error('Choose a wallet backup under 12 MB.')
      await this.client.importEncryptedBackup(await file.text(), password, {}); done()
    })
  }

  /** Background check of an open invoice; called every few seconds. */
  poll() {
    if (!this.dialog.open || this.busy || this.polling || this.wallet.status !== 'ready' || !this.invoiceId) return
    const invoice = this.wallet.invoices?.find(item => item.id === this.invoiceId)
    if (invoice?.expiresAt && invoice.expiresAt < Date.now() / 1000) { this.render(); return }
    if (!invoice || !['unpaid', 'pending'].includes(String(invoice.state).toLowerCase()) || invoice.expiresAt && invoice.expiresAt < Date.now() / 1000) return
    this.polling = true
    void this.client.checkInvoice(this.invoiceId).catch(cause => this.error(cause)).finally(() => { this.polling = false })
  }

  async escrow(request: EscrowAction) {
    if (this.options.isPreview()) throw new Error(PREVIEW_NOTICE)
    await this.load()
    if (!this.client || this.client.state().status !== 'ready') throw new Error('Open Wallet and enable or unlock it to use escrow.')
    return this.client.escrow(request)
  }
}
