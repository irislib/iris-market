# Native app contract, v0

UniFFI module `IrisMarketCore` (Swift) / package `to.iris.market.core` (Kotlin), library `iris_market_app`.

- `generateSecretKey() -> String` returns hex; native stores in Keychain/Keystore, never preferences/plain files. Root account key is excluded from snapshots.
- `MarketApp(dataDir: String, secretKey: String, demo: Bool)` throws.
- `MarketApp.withIdentity(dataDir, ownerPublicKey, ownerSecret?, deviceSecret, authorization?)` opens an owner/device account. `authorization` is the exact owner-signed AppKeys event JSON. The old constructor and encrypted conversation database remain compatible.
- `publicKeyForSecret(secret)` resolves a pasted Nostr secret locally. `registerIdentityDevice(ownerSecret, deviceSecret, relaysJson)` requires completed signed roster discovery, merges the device without replacing siblings, rejects conflicts and requires relay acknowledgement. Native stores the returned public proof with the secure per-owner credential bundle.
- `MarketDeviceLink(deviceSecret, restoredBootstrap?, approvalRelay)` creates or resumes the canonical nostr-identity / Iris Chat approval flow. `invitation()` is the shareable bootstrap; `bootstrap()` is private checkpoint data and belongs in secure storage. `poll(accountRoot)` returns optional public `{owner_public_key, authorization}` after exact current device and approver authorization, with the pairing imported under `accountRoot/<owner>`. Persist `bootstrap()` after each poll. No owner secret is transferred.
- `snapshot() -> String` returns JSON or throws a storage error.
- `command(request: String) -> String` throws and returns the new snapshot. Run blocking commands off UI thread. Poll snapshot every 2 seconds while active.
- `shutdown()` stops network resources.

Snapshot shape (snake_case JSON):
```
{
 "public_key":"hex", "can_sign":true, "messaging_ready":true, "demo":false, "status":"Ready", "error":null,
 "query":"", "side":"all", "ai_search":false, "sort":"suggested", "revision":0,
 "listings":[{"id":"author:d","author":"hex","title":"...","description":"...","side":"offer","price":"85","currency":"EUR","location":"Helsinki","category":"Electronics","image_url":null,"created_at":0,"expires_at":null,"status":"active","saved":false,"mine":false,"delivery":"published","relevance":null}],
 "saved_count":0,
 "settings":{"currency":"USD","currency_initialized":false,"send_delivery_receipts":true,"send_read_receipts":true,"relays":["wss://relay.damus.io","wss://nos.lol","wss://relay.primal.net"],"ai":{"enabled":false,"provider":"compatible","base_url":"https://api.openai.com/v1","model":"","interests":"","curate_feed":false}},
 "conversations":[{"id":"...","name":"...","messages":[{"id":"...","text":"...","mine":true,"created_at":0,"created_at_ms":0,"delivery":"sent","reactions":[{"emoji":"👍","count":1,"reacted_by_me":false}]}]}],
 "invite":null, "profile":null, "people":{}, "graph_context_loaded":false
}
```

Actions use a `type` discriminator:
- `{"type":"set_filter","query":"","side":"all","ai_search":false}`; side all/offer/request. AI mode uses the same query as the model condition and keeps unreviewed candidates visible; ordinary mode performs text matching. Query/mode changes clear previous decisions.
- `{"type":"set_sort","sort":"suggested"}`; Suggested or Newest. Suggested combines verified social distance, freshness, locally saved category interests and author diversity. Snapshot listings contain current filters. Saved tab may locally select `saved`.
- `{"type":"load_profile","author":"hex-or-npub"}` starts a bounded public profile fetch and updates `profile`. `people` contains display metadata/relationships for listing authors. The fixed visitor graph root is Sirius Business; only signed kind-0/kind-3 events are used. Follower results are observed/partial; badges express graph relationships, not identity verification.
- `{"type":"load_context"}` refreshes the bounded default graph; live startup also warms it once. Preview never requests public profiles.
- `{"type":"save","id":"..."}` toggles bookmark.
- `{"type":"publish","draft":{"title":"...","description":"...","side":"offer","price":"85","currency":"EUR","location":"...","category":"Electronics","image_url":null}}` validates/persists then sends. Demo mode rejects publication, does not create network traffic.
- `{"type":"close","id":"..."}` closes own listing.
- `{"type":"refresh"}` attempts internet refresh; offline listings remain available.
- `{"type":"set_settings","settings":{...}}` saves nonsecret settings; no model key here.
- `{"type":"initialize_currency","currency":"GBP"}` initializes only fresh preferences, once. Native selects an already-known device locale currency from `supported_currencies`, otherwise USD. `settings.currency_initialized` is true for older saved records, preserving their existing choice. Manual settings saves set it true. `sats_display_price` is an optional cached display conversion for one sat, with currency/source/time/stale metadata; missing rates leave amounts in sats and test funds never use fiat conversion.
- `{"type":"curate","api_key":"..."}` classifies bounded candidates with configured model. API key stays in memory, never logs/persistence. Passing empty string is valid for local models. Relevance is `{ "show":true, "reason":"..." }`; failures leave cards visible.
- `{"type":"check_ai","api_key":"..."}` tests configured model. Status contains result.
- `{"type":"contact","author":"hex","listing_id":"..."}` discovers the verified author's public NDR invitation in an isolated anonymous scope and starts a private conversation.
- `{"type":"create_invite"}` creates a private messaging invitation and returns it in snapshot.invite.
- `{"type":"accept_invite","invite":"..."}` connects a private conversation.
- `{"type":"send_message","peer_id":"...","text":"..."}` sends ratcheted text.

AI provider: `compatible` (OpenAI-compatible /chat/completions), `ollama` (native /api/chat), `anthropic` (/v1/messages). Model and endpoint explicit, no default model guessed. Secure key stored separately by native app. Show a brief consent explanation before enabling: selected listing text and interests go to this provider. Never send private conversations.

Preview: pass demo=true only for explicit Preview action or --demo launch arg. Core returns labeled sample inventory and makes no outbound calls. Show a subtle persistent `Preview` badge. No fake users/listings in live mode.

Native UI: polished warm-light marketplace, photographic cards if image_url present, illustrated category tiles otherwise. Browse/search chips, saved cards, inbox, profile/settings. New listing sheet, detail sheet, bookmark, refresh, AI settings. Empty states purposeful and concise. Do not show pubkeys/relay jargon in normal browse. Settings can show server URLs, account ID and advanced fields.

## Native maps

`listings[].coordinates` is null or `[longitude, latitude]`, decoded from the most-specific valid signed `g` tag. It is the published geohash cell centre, not a verified street address. Textual locations are never geocoded implicitly.

The native Map toggle opens the isolated `https://market.iris.to/native-map.html` surface with the same Hashtree assets as the browser. A narrow bridge sends only public listing IDs/titles/coordinates and appearance; marker selection is checked against the native listing set. Keys, private messages and drafts are never injected. The read-through WebView cache defaults to 512 MiB and is managed by the map page. The remote shell requires internet on first open; this is not an offline-region or mesh guarantee. Maps are disabled in native Preview to keep its no-network contract.

## Account and private-message boundaries

Account bundles and device-link checkpoints are in Keychain/Keystore, partitioned by owner. Switching accounts shuts down the old core before opening the new database and preserves previous conversations. Missing active credentials fail closed. `can_sign` gates public listing publication; a linked device with no owner signer can use authorized private chat, but cannot publish owner-signed listings. `messaging_ready` reflects exact current signed membership; owning a secret key cannot override a newer revocation.

Private discovery uses canonical Iris Chat AppKeys kind 37368 and device invitation kind 30078 with `l=double-ratchet/invites`. Approved account opens queue the canonical device invitation, including linked devices with no listing signer. Revoked or unregistered legacy profiles do not advertise automatically. The native adapter accepts the canonical JS ownerless invitation only when the selected owner is established by verified AppKeys. Both owner-authored and exact authenticated-device-authored kind-14 rumors are accepted. Metadata-private 1059/1060 messages remain isolated from the public feed. Durable ciphertext retries retain their actual destination owner (including copies to one's own linked devices) and fail closed on retained roster conflicts or revocation.

The opt-in `js_interop` test consumes synthetic local fixtures generated by `web/tests/fixtures/ndr-interop.mjs`; it never contacts public accounts. Native Preview continues to make no network calls.

## Private delivery receipts and emoji reactions

- `{"type":"toggle_reaction","peer_id":"owner-hex","message_id":"inner-event-hex","emoji":"👍"}` queues an encrypted kind-7 rumor for a known message in that exact conversation. Each authenticated author has one reaction; selecting the same emoji again sends an empty removal. Message `reactions` is an array of `{emoji,count,reacted_by_me}`, defaulting to empty for older records. Reaction heads use `(ms,event_id)` ordering, retain removal tombstones, and survive restart and out-of-order replay.
- `{"type":"mark_messages_read","message_ids":["inner-event-hex"]}` records only the supplied, known incoming IDs and queues seen receipts for those IDs. Call it only for actual visible rows while the conversation is foreground and uncovered. Opening a conversation does not authorize acknowledging its entire history.
- `settings.send_delivery_receipts` and `settings.send_read_receipts` default to true. Disabling either suppresses new receipts and removes matching jobs not yet encrypted. Previously authorized receipts already encoded in the ciphertext outbox may still publish.

Message `created_at` remains Unix seconds for display. `created_at_ms` retains the private rumor's validated `ms` tag; new outgoing messages use a durable monotonic millisecond allocator. Rows sort stably by that value, with second precision and existing tie order preserved for legacy records. Missing historical subsecond precision is not reconstructed from random event IDs.

Outgoing message `delivery` is `pending`/`queued` before relay acceptance, `sent` after relay acknowledgement, `delivered` after the authenticated peer durably accepts the message, and `seen` after its explicit read receipt. These states only advance. Incoming messages use `received`; revoked or otherwise unsendable local messages can use `failed`. A relay acknowledgement never establishes peer delivery or reading.

Receipts are ratcheted kind-15 rumors with `delivered`/`seen` content and exact target `e` tags. Controls never become chat rows or trigger receipt loops or notifications. Message persistence and receipt scheduling share one encrypted transaction; optional receipt backpressure never rejects valid message ingestion or read actions. Outbound control work, bounded unmatched controls and reaction heads are encrypted at rest. Author/device membership and exact conversation/target ownership are checked before applying them. No plaintext public kind-7 or kind-15 event is published.

## Private orders and foreground location

These interfaces describe current source; they do not establish acceptance of a new signed native build. Commands use snake_case arguments; order records and nested delivery/payment fields use the existing browser camelCase wire format. `orders` contains the participant's private order views, and `live_location_supported` is true in current source.

- `{"type":"request_order","listing_id":"author:d","quantity":1,"note":"...","delivery_request":null}` requests the canonical listing/price. Optional `delivery_request` is `{pickup:{label,address,coordinates?},destination:{label,address,coordinates?},collection?:{merchant,reference}}`. Coordinates are `[longitude,latitude]`. The initial delivery request is immutable.
- `{"type":"request_delivery","source_order_id":"product-order-id","listing_id":"courier-author:d","destination":{"label":"Home","address":"..."}}` creates a separate buyer↔courier order from the buyer's accepted/in-transit product order with a collection stop. It atomically authorizes that courier on the original product order. The merchant does not become a participant in the courier order, and the courier does not receive the product conversation, product order ID or contents. `sourceOrderId`/`deliveryOrderId` are local navigation links, never wire references.
- `{"type":"update_order","order_id":"...","patch":{"payment":{"mint":"https://...","amount":"16","unit":"sat","status":"requested"}}}` is seller-only. Amount is a canonical positive integer string. The seller alone changes `status` to `received` after actual redemption; received payment and its terms cannot be reverted. Buyer snapshots cannot assert seller payment state.
- `{"type":"send_order_payment_token","order_id":"...","token":"cashuB..."}` rechecks the live order: caller must be buyer, payment requested and order nonterminal. Token mint/unit/face amount must match the current request. It durably queues an ordinary encrypted kind-14 order-context message to the seller without waiting for relay acknowledgement. Retrying the same token/order returns success without a duplicate message. It never marks payment received. Wallet callers must retain/recover the created token if queuing fails and retry the same reviewed wallet operation.
- `{"type":"update_order","order_id":"...","patch":{"pickupAuthorization":{"courierPubkey":"hex","reference":"opaque-reference"}}}` is buyer-only on accepted/in-transit orders; null clears authorization. It does not add the courier as a product-order recipient.
- Existing status, shipment and stop patches remain available. `{"type":"update_order","order_id":"...","patch":{"location":{"coordinates":[24.9,60.2],"stopId":"..."}}}` sends only for an authorized delivery handler and valid current stop. `{"location":null}` stops sharing. Location work is coalesced and expires after 120 seconds; old coordinates are not retained as an offline history. Unready recipient devices fail closed without disrupting ordinary chat queues. Platform UI must explicitly start sharing only in the foreground, uncovered active order view, and stop on leaving/backgrounding. This does not enable background tracking.

One-item order views may include local-only `display_price` using cached selected-currency conversion; wire item prices remain unchanged. Payment mint/amount/status, `deliveryRequest` and `pickupAuthorization` remain separate fields. `archive_order` changes only local visibility.

## Public uploads and reviews

These blocking `MarketApp` methods run off the UI thread and remain separate from private order/chat state:

- `uploadMedia(bytes, name, mime) -> String` explicitly uploads a public attachment (1 byte–8 MiB), verifies the downloaded content hash, and returns camelCase `{url,nhash,fileLink,name,mime,size,isImage}`. Platforms re-encode photos to strip metadata before this call; generic files preserve their contents. Uploading does not publish a listing, and previewing a draft must not call it. No account secret or upload authorization enters public event indexes.
- `reviews(target, product, refresh) -> String` returns the bounded public review projection as a JSON array. A product target is its canonical listing address; a profile target is owner hex. `refresh` explicitly requests public relay recovery. Rows use `{id,author,subject,target,rating,ratingMax,body,updatedAt}`. Signed revisions/deletions and target ownership are validated before projection.
- `publishReview(target, rating, body) -> String` explicitly queues a signed public profile review (target owner hex, integer rating 1–5) and returns the updated JSON review array. Product reviews are read through `reviews(..., product=true, ...)`; this publication method is profile-only. The signer must have public signing authority. Reviews are public statements, not verified-purchase attestations; do not include private order IDs, routes or chat contents.

## Native wallet

The `cashu-wallet` Cargo feature pins published `nvpn-cashu-service = 0.4.11` with CDK 0.18.0. Matching bindings and fresh native build/runtime acceptance remain gates for the reviewed-send, outgoing Lightning and backup interfaces below. It is enabled by default for the native app crate and established native build commands. Matching generated bindings are required. Core money-operation fixtures and platform linking do not replace final native UI/device release acceptance.

The feature adds a separate `MarketWallet` UniFFI object, never wallet fields to `MarketApp.snapshot`. Constructor arguments are a private wallet base directory, owner/device public keys and the exact 64-byte seed as hex. The directory is partitioned by both owner and device. Before constructing, the shared native `WalletCredentials.loadOrCreate` adapter reads `cashu.seed.<owner>.<device>` from Keychain/Keystore. If absent, `walletHasData` must be false before generating a random seed with `generateWalletSeed`; write and read it back exactly before opening. Existing data plus a missing or mismatching seed is a recovery error. Chat linking and Nostr account recovery never silently derive, transfer or replace this seed. The adapter persists only a one-way seed binding alongside the existing CDK database. Platform file protection must cover the private SQLite proof store.

- `snapshot(refresh)` returns local balance totals, per-mint balances and redacted history. `total_sats` excludes unbacked test funds; `test_sats` is separate, and each mint-bearing result includes `test_only`. Refresh explicitly contacts existing mints and recovers durable pending operations. No token, proof, invoice, quote ID, payment preimage or seed appears in this response.
- `previewCashuToken(token)` parses locally and returns mint/amount/unit. The receiving screen must show the mint before calling `receive(token, approvedMint)`; only HTTPS mints and sats are supported.
- `topUp(mint, amount)` creates a Lightning invoice and returns it only to the explicit funding screen.
- `previewSend(mint, amount, requestId)` returns `{request_id,mint_url,amount_sat,fee_sat,max_total_sat,existing}`. Show amount, maximum fee and total before confirmation. `sendReviewed(mint, amount, maxFee, requestId)` enforces that approval and returns private `{mint,test_only,amount,fee,operation_id,token}`. Retries reuse the same durable request ID; an order payment uses `order-payment:` plus SHA-256 of `orderId + "\n" + mint + "\n" + amount`. Do not create a fresh request ID after an uncertain outcome. Legacy `send(mint, amount)` remains exposed but reviewed native UI uses the explicit preview/confirm pair.
- `previewLightning(mint, invoice)` returns `{mint_url,quote_id,amount_sat,fee_sat,max_total_sat,expiry_unix,state}`. Only after explicit fee confirmation call `payLightning(mint, quoteId, maxFee)`; its paid response includes amount, fee and quote/operation state. Invoice creation and payment are separate explicit actions. Do not offer real-money handoff/payment of unbacked test-mint invoices.
- `exportBackup(password)` returns password-encrypted JSON containing this wallet's recovery material and database. Keep plaintext seeds/proofs out of UI, logs and ordinary exports. Static `nativeWalletBackupSeed(backup,password,expectedOwner)` validates/decrypts only for the selected owner; persist/read back that imported seed through platform secure storage before static `restoreNativeWalletBackup(baseDir,ownerPublicKey,devicePublicKey,backup,password,savedSeed)`. Restore only before opening a wallet and into a fresh wallet namespace; never overwrite an existing wallet. This supports the same owner's new-device migration, not importing another owner's funds. `snapshot.review_required` blocks spending/sharing recovered tokens until an explicit successful refresh.
- `pendingToken(operationId)` is an explicit private recovery action for the sharing screen; normal history stays redacted. `reclaim(mint, operationId)` explicitly attempts to reclaim an unspent pending token.

The default mint suggestion is Coinos. The seed, bearer token and invoice may only be displayed/copied/shared by the corresponding explicit wallet action. They must never enter public listings, analytics, AI requests, ordinary logs or plaintext/public Nostr events. A buyer may explicitly send a bearer token through the encrypted private order-context command above. Wallets remain independent across accounts/devices until an explicit transfer.

## Images

`settings.image_proxy` is `{ "enabled": true, "url": "https://imgproxy.iris.to" }` by default. The core snapshot resolves listing images and all profile/avatar rows using the same signed image-proxy contract as Iris Chat RS. Stored Nostr events retain their original URLs. Only explicit proxy disable returns direct image URLs; configuration or loading failures never trigger direct fallback. Custom proxy endpoints must use HTTPS and the documented public Iris proxy signing configuration. Native settings expose the toggle and endpoint; account/API secrets are unrelated to these public signing constants.
