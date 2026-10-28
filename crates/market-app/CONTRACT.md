# Native app contract, v0

UniFFI module `IrisMarketCore` (Swift) / package `to.iris.market.core` (Kotlin), library `iris_market_app`.

- `generateSecretKey() -> String` returns hex; native stores in Keychain/Keystore, never preferences/plain files. Root account key is excluded from snapshots.
- `MarketApp(dataDir: String, secretKey: String, demo: Bool)` throws.
- `snapshot() -> String` returns JSON or throws a storage error.
- `command(request: String) -> String` throws and returns the new snapshot. Run blocking commands off UI thread. Poll snapshot every 2 seconds while active.
- `shutdown()` stops network resources.

Snapshot shape (snake_case JSON):
```
{
 "public_key":"hex", "demo":false, "status":"Ready", "error":null,
 "query":"", "side":"all", "revision":0,
 "listings":[{"id":"author:d","author":"hex","title":"...","description":"...","side":"offer","price":"85","currency":"EUR","location":"Helsinki","category":"Electronics","image_url":null,"created_at":0,"expires_at":null,"status":"active","saved":false,"mine":false,"delivery":"published","relevance":null}],
 "saved_count":0,
 "settings":{"relays":["wss://relay.damus.io","wss://nos.lol"],"ai":{"enabled":false,"provider":"compatible","base_url":"https://api.openai.com/v1","model":"","interests":"","curate_feed":false}},
 "conversations":[{"id":"...","name":"...","messages":[{"id":"...","text":"...","mine":true,"created_at":0}]}],
 "invite":null
}
```

Actions use a `type` discriminator:
- `{"type":"set_filter","query":"","side":"all"}`; side all/offer/request. Snapshot listings contain current filters. Saved tab may locally select `saved`.
- `{"type":"save","id":"..."}` toggles bookmark.
- `{"type":"publish","draft":{"title":"...","description":"...","side":"offer","price":"85","currency":"EUR","location":"...","category":"Electronics","image_url":null}}` validates/persists then sends. Demo mode rejects publication, does not create network traffic.
- `{"type":"close","id":"..."}` closes own listing.
- `{"type":"refresh"}` attempts internet refresh; offline listings remain available.
- `{"type":"set_settings","settings":{...}}` saves nonsecret settings; no model key here.
- `{"type":"curate","api_key":"..."}` classifies bounded candidates with configured model. API key stays in memory, never logs/persistence. Passing empty string is valid for local models. Relevance is `{ "show":true, "reason":"..." }`; failures leave cards visible.
- `{"type":"check_ai","api_key":"..."}` tests configured model. Status contains result.
- `{"type":"contact","author":"hex","listing_id":"..."}` discovers the verified author's public NDR invitation in an isolated anonymous scope and starts a private conversation.
- `{"type":"create_invite"}` creates a private messaging invitation and returns it in snapshot.invite.
- `{"type":"accept_invite","invite":"..."}` connects a private conversation.
- `{"type":"send_message","peer_id":"...","text":"..."}` sends ratcheted text.

AI provider: `compatible` (OpenAI-compatible /chat/completions), `ollama` (native /api/chat), `anthropic` (/v1/messages). Model and endpoint explicit, no default model guessed. Secure key stored separately by native app. Show a brief consent explanation before enabling: selected listing text and interests go to this provider. Never send private conversations.

Preview: pass demo=true only for explicit Preview action or --demo launch arg. Core returns labeled sample inventory and makes no outbound calls. Show a subtle persistent `Preview` badge. No fake users/listings in live mode.

Native UI: polished warm-light marketplace, photographic cards if image_url present, illustrated category tiles otherwise. Browse/search chips, saved cards, inbox, profile/settings. New listing sheet, detail sheet, bookmark, refresh, AI settings. Empty states purposeful and concise. Do not show pubkeys/relay jargon in normal browse. Settings can show server URLs, account ID and advanced fields.
