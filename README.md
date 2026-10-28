# Iris Market

A general marketplace for things, skills and opportunities. Native iOS, Android and macOS apps share a Rust core for selling, buying, bookmarks and private enquiries. The browser app supports visual browsing, Nostr sign-in, listing publication, private chat and share links. AI assistants can use the same native operations through the CLI or MCP.

**Internet first.** Ordinary Nostr servers provide discovery and delivery in this prototype. Nearby Wi-Fi/Bluetooth and FIPS mesh exchange are planned backup carriers. They are not implemented or advertised as working in v0. Intermediary matching ("asking for a friend") is also deferred.

## Current prototype

- SwiftUI iOS and Jetpack Compose Android interfaces, plus a responsive browser app. Appearance can follow the system or use a light/dark override. Preview is explicit and separate from live inventory.
- Signed NIP-99 listings, Selling/Buying search and bookmarks. Native/CLI clients add withdrawal, local persistence and durable listing publication queues. Browser posting retains the signed retry attempt while its form remains open; it is not a durable draft archive. A server acknowledgement confirms publication; a queued event is not reported as delivered.
- Private enquiries and invitation links use the published Iris Chat protocol engines. Protocol state, message history and the private outbox are encrypted at rest. Native account and provider credentials use Keychain / Android Keystore. Browser chat uses `nostr-double-ratchet` 0.0.183 with separate approved device keys, new-message fanout and revocation.
- Configurable OpenAI-compatible, Anthropic and Ollama endpoints and model names. AI is disabled by default. Optional yes/no relevance decisions use only selected public listing text and user-provided interests; private conversations are never sent. All listings remain accessible, and failures do not hide undecided listings.
- Browser browsing, local bookmarks and shareable listing details work without an account or signing key. The default page loads real Nostr listings; fixtures are restricted to explicit Preview. Tags and public follow lists can narrow discovery. Enter a name to create a profile, or choose Existing profile for a browser extension, NIP-46 remote signer, device linking or an imported private key. A linked chat device connects the same account’s posting signer separately when needed.
- Public author profiles, following and observed follower lists, known connections and relationship checkmarks. The visitor network starts from Sirius Business, including when no account is signed in.
- Suggested ordering combines public social connections, freshness, saved interests and seller variety; Newest remains available.
- Listing maps use the same pinned Hashtree basemap as Iris Maps, with a bounded public-data cache and markers from signed geohash tags.
- One search field for text or optional AI matching. Browser-local AI uses explicit model downloads, inline progress, cancellation and a Show all override. It is experimental; marketplace accuracy is not established.
- Named CLI commands, a local JSON action interface and MCP stdio tools for search, publication, bookmarks, contact and messages.

This is a development prototype. The browser includes an optional Cashu wallet; shipping guarantees, escrow, automatic earlier-history transfer, group conversations and saved matching watches are not implemented. Native Cashu adapters and secure seed storage are present behind the disabled `cashu-wallet` feature; native wallet compilation and UI acceptance are pending. Native local AI uses a configured endpoint rather than bundled model weights. No public App Store, APK or CLI binary release is published.

Web: [market.iris.to](https://market.iris.to) · [App builds and CLI](https://getmarket.iris.to). Source: [GitHub](https://github.com/irislib/iris-market). Hashtree source: [iris-market](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-market).

## Repository

- `crates/market-core`: validation, local SQLite data, relay transport, ratchet adapter, public profiles, ranking and AI curation.
- `crates/market-app`: UniFFI entry point shared by native apps.
- `crates/market-cli`: local agent commands and MCP.
- `ios`, `android`: native presentation, secure credentials and lifecycle.
- `web`: browser client, Nostr account/signing adapters, private messaging, public profiles, ranking, currency display, Hashtree maps, the native map shell and optional local AI worker.
- `site`: download/build landing page; it currently links to source instructions rather than released binaries.
- `scripts`: repeatable builds and focused UI checks.
- `crates/market-app/CONTRACT.md`: native command/state contract.

The product remains general. Specialised task details can extend a common listing rather than requiring separate category-specific apps. Public discovery and private conversations remain separate; future private matching will need explicit disclosure and delegation permissions.

## Build

Rust is pinned by `rust-toolchain.toml`; dependency checksums and versions are in `Cargo.lock`. Builds use `--locked`. Native generated bindings are regenerated from the same Rust library used by each platform.

```sh
./scripts/verify-fast
cargo build --locked -p iris-market-cli
```

### Browser and download page

Requires Node.js 22 or newer; the tested version is pinned in `.nvmrc` (26.12.0). `web/package-lock.json` pins the browser, build and deployment dependencies. The browser and download page build together:

```sh
cd web
npm ci
npm test
npm run build
npm run dev
```

The local browser opens at `http://127.0.0.1:4173`; add `?preview=1` for sample listings without relay connections. To serve the download page instead, run `MARKET_SITE=downloads PORT=4174 npm run dev`. The build writes `web/dist` and `site/dist`; it also packages the native map shell, MapLibre workers, local AI worker, compressed WASM runtime and third-party notices. It includes no model weights or map archive. All npm inputs, including Hashtree and social-graph release tarballs, have integrity hashes in the lockfile. The build verifies the exact unpacked ONNX runtime hash before compression.

The checked-in Cloudflare configurations target the domains above. With an authorised hosting account, deploy the built assets from `web` with the lockfile-installed Wrangler binary:

```sh
./node_modules/.bin/wrangler deploy --config wrangler.jsonc
./node_modules/.bin/wrangler deploy --config ../site/wrangler.jsonc
```

A successful build does not establish deployment. Verify both HTTPS destinations after deployment. No credentials or account identifiers belong in source.

Hashtree can publish the same tested static directories as the named trees `market` and `getmarket`. From the repository root, set `HTREE_BIN` to an installed `htree` executable. The release script checks its pinned SHA-256; the current pin is for the Darwin arm64, source-built Haps 0.1.22 helper (`htree` 0.2.150), with provenance recorded in the script. It does not install tools or build assets. Commit the accepted source and inspect the final build before publishing:

```sh
node --test scripts/publish-hashtree.test.mjs
node scripts/publish-hashtree.mjs inspect web
node scripts/publish-hashtree.mjs inspect downloads
node scripts/publish-hashtree.mjs publish web --commit FULL_COMMIT --assets WEB_MANIFEST_SHA256
node scripts/publish-hashtree.mjs verify web --ref PUBLISHED_NHASH --assets WEB_MANIFEST_SHA256
node scripts/publish-hashtree.mjs publish downloads --commit FULL_COMMIT --assets DOWNLOAD_MANIFEST_SHA256
node scripts/publish-hashtree.mjs verify downloads --ref PUBLISHED_NHASH --assets DOWNLOAD_MANIFEST_SHA256
```

Use the full commit and asset digests returned by `inspect`, and each immutable hash returned by `publish`. Publication requires a clean working tree and writes through the publisher's configured Hashtree identity. Verification downloads every file with a fresh configuration and cache, without a signing identity or local daemon, then compares the exact asset manifest. Run the two verification steps sequentially; each removes its own temporary download and cache. Source publication is separate: push the accepted full commit to `htree://self/iris-market` as `refs/heads/main`, then verify that commit and its history through a fresh public-owner fetch. These commands support static web/download releases; signed native and CLI binary releases are not implemented. Treat a channel as published only after its public read succeeds.

The browser validates signed NIP-99 events before displaying them and retains sold/expired revisions for the life of the page. A `?listing=<author:identifier>` link adds a narrow lookup for that listing beyond recent inventory. Saved IDs, relay preferences and appearance are local to the browser; listings are not a persistent offline browser archive. The Open app link opens an installed native client; it does not yet hand off the selected listing or implement universal links.

### Browser accounts and messages

Browser sign-in creates or restores a separate stable chat device key authorized by the account’s signed AppKeys roster. Browser extensions retain the account private key outside Market. NIP-46 chat sign-in requests only device-authorization signing; a linked device can later connect the same account’s extension or remote signer for profile, follow-list and listing signatures. A mismatched account is rejected. The public posting connection requests kinds 0, 3, 30402 and 24242 and expires after fifteen minutes. Kind 24242 is restricted to validated, short-lived upload authorizations and is never published to Nostr relays. Account creation and private-key import keep their account key in the encrypted browser vault. Backups are exposed only by the explicit account action.

The vault encrypts its full snapshot with AES-GCM in IndexedDB. The default sign-in interface uses a per-origin, nonextractable WebCrypto key stored by the browser, so it does not require a new password. The storage adapter also supports an optional passphrase mode using PBKDF2-SHA256; this is not currently a separate setup choice in the sign-in interface. Browser-managed encryption protects stored data, not an unlocked page from malicious scripts. Lock closes messaging connections and drops the in-memory keys and messages. The vault currently limits its serialized private data to 8 MiB and each conversation to 1,000 messages; it rejects stale writes from another browser tab instead of overwriting newer ratchet state.

New messages fan out to authorized recipient devices and the sender’s other devices. Removing a device prevents new sends and retrying queued ciphertext to that device once the newer signed roster is observed. This does not transfer earlier message history to a newly linked device. Failed registration retains the pending device key before publication, so a retry can finish the same authorization. Private outbox entries retain the exact signed ciphertext for retry; `sent` means server acknowledgement, not a read receipt. Relay setting changes reconnect the same account and device. Offline restoration keeps sending paused until signed authorization can be checked against available server responses.

Private invitation URLs carry their capability in the fragment. The browser captures an `/invite#…` link in memory, immediately removes the fragment from the visible URL, and offers an explicit action to open it after sign-in. Invitation capabilities are never added to public listings or profile queries.

Feed filters support up to eight Nostr tags and the direct follows of a public `npub` or hexadecimal key. The follow filter verifies kind-3 events from the configured relays, supports up to 256 followed authors, and preserves the existing feed if lookup fails. This exact-author filter is separate from the broader profile/ranking graph described below. It requires no login. Public follow and tag queries are visible to the chosen relays.

### iOS simulator

Requires macOS, Xcode with an arm64 iOS simulator SDK, XcodeGen and the `aarch64-apple-ios-sim` Rust target. The app targets iOS 16+. The Rust C dependencies receive the matching minimum deployment version.

```sh
./scripts/ios-core
./scripts/ios-build
```

Simulator signing is ad hoc and uses simulator-only entitlements so Keychain works. It requires no personal signing team. Physical-device distribution and App Store release are not configured.

UI tests require an explicitly allocated simulator. They never select or reset an arbitrary device:

```sh
MARKET_IOS_SIMULATOR_ID=<allocated-simulator> ./scripts/ios-ui-check
```

### Android

Requires JDK 17, Android SDK 36, NDK 28.2.13676358 and the `aarch64-linux-android` Rust target. The initial APK is arm64 and targets Android API 29+. Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` to the installed SDK.

```sh
./scripts/android-build
```

The Gradle wrapper distribution and wrapper binary are pinned and checked. The committed lockfile and dependency-verification metadata cover the resolved build inputs; routine builds use strict verification. `--bootstrap-locks` is for deliberately reviewing dependency changes, not normal builds.

UI tests require an explicitly allocated emulator: `./scripts/android-ui-check emulator-<allocated-port>`. This runner rejects physical devices and never selects an arbitrary emulator.

### App preview

The iOS simulator accepts `--demo`; Android accepts the boolean intent extra `demo=true`. Native Preview uses sample inventory, separate storage and no network calls. The browser uses `?preview=1`, makes no relay connections and disables public-follow lookups in Preview. Explicitly loading a browser AI model or opening the browser map can still download public assets while viewing sample listings. Native Preview disables network-backed maps and live profile queries. Sample posts can never be published. Live mode starts with verified relay inventory.

## Profiles and discovery

Open an author from a listing to view public kind-0 metadata, following, observed followers and people in the selected network who follow that author. Browser profiles have share links using `?profile=<public-key>`. Profile and follow-list events are signature-checked before they reach `nostr-social-graph`; winner selection follows creation time and the lowest event ID on a tie. Native and web relationship presentation reuses the Iris Chat rules with its MIT attribution preserved.

Sirius Business is the default network root in both clients, using the same public key as Iris Client: `4523be58d395b1b196a9b8c82b038b6895cb02b683d0c253a955068dba1facd0`. A visitor does not need to sign in. The browser also allows an explicit public-profile override. Labels name the selected root, so “known” does not imply that a visitor personally knows those people. Direct follows receive the following checkmark; a second-degree connection receives a friend checkmark, or the stronger connection style when more than ten people followed by the root also follow that author. These marks describe observed graph relationships, not verified identity, reliable transactions or seller endorsement.

For the default Sirius Business context, the browser also loads a SHA-256-pinned serialized snapshot from `nostr-social-graph@2.0.4` (1,182,110 bytes). It provides initial ranking and helps select bounded second-hop lookups. Its edges are older unsigned data: they never produce trust badges or known-follower claims. Those indicators require live signature-checked lists. Verified live records take precedence over snapshot edges, including observed unfollows and unsupported newer records.

The graph is deliberately partial: each signed list accepts up to 4,096 public keys, discovery fetches at most 32 second-hop lists, profile lookup considers at most 64 inbound candidates, and lists display at most 256 people. Inbound candidates are refreshed without the follower filter before they are shown, so a stale follow record does not override an observed later unfollow. Counts and distances describe the loaded public records, not the entire Nostr network. Missing records remain unknown. Profile reads never publish follow/unfollow events, and no private contact list is uploaded.

Suggested ordering is deterministic over the available inventory. It gives up to 8 points for social distance, up to 2 for known followers, up to 4 for freshness with a 14-day half-life, up to 3 for categories represented in locally saved listings, and up to 2 for title matches to the search. Each earlier listing from the same author subtracts 6 points while selecting the next item. This limits catalogue dominance without excluding unknown authors. Price, offer/request status, paid placement and click tracking do not increase rank. The graph loads in live mode; until it arrives, freshness, interests and variety still work. Saved interests remain on the device. Choose Newest to bypass Suggested ordering.

## Browsing and media

Selling is selected initially; Buying switches to wanted listings. The grid starts with 24 cards and appends 24 at a time near the bottom. After three automatic batches, Load more keeps the footer reachable. Already browsed cards stay in place as live results change. Filters or a new sort reset the window. Older relay history is requested separately with bounded requests, signature checks, inclusive timestamp boundaries and an explicit retry on failure. The page retains at most 1,000 listing coordinates, including tombstones; it does not claim to contain the entire network.

Remote listing photos and avatars use the Iris image proxy by default, with a configurable HTTPS endpoint in Settings. Failed images become neutral surfaces without exposing the original image host through an automatic direct retry. Disabling the proxy deliberately contacts original image hosts.

Descriptions support Markdown with safe DOM rendering. Raw HTML remains text; remote images follow the proxy setting. The browser composer accepts up to four public photo/document/file attachments, each up to 8 MiB. Raster photos are re-encoded to remove embedded metadata. Uploads use Hashtree leaf blobs and include content hashes, nhash references, NIP-92 metadata and ordinary HTTPS Markdown links for interoperability. Each public download is hash-verified before the listing can be published. Failed uploads retain the selected files and completed uploads for retry. Uploading does not itself publish a listing; the files are public once uploaded. Generic documents retain their contents and metadata.

## Cashu wallet

The browser wallet is opt-in and currently supports the Coinos mint. The mint holds the underlying funds. Wallet seed and proofs are separate from Nostr keys and chat, encrypted in a local browser vault; they do not synchronize with linked chat devices. Export an encrypted wallet backup before adding funds. Restored backups require a proof-state refresh before spending and use a new seed for future outputs.

Transfers persist their exact outputs and reserved inputs before contacting the mint. Interrupted operations recover using the same journal. An unpaid Lightning payment can reclaim its reserved value through a fresh swap after checking the quote and proof states; it never simply makes potentially spent inputs available again. Tests use synthetic funds, including failed responses, concurrent payment/reclaim races, restart recovery, fees and full-storage boundaries. No live-money test was performed.

## Price display

The display currency defaults to EUR and is retained locally. Listings preserve their original amount and currency; conversions are approximate display estimates. SAT/SATS/satoshi aliases normalize to satoshis, with exactly 100,000,000 satoshis per BTC. The rate adapter first checks configured relays for signed quotes from the pinned Snort publisher, accepting fresh quotes up to fifteen minutes old. It can fall back to Coinbase’s public BTC exchange-rate endpoint. No Snort quotes were observed in the live acceptance probe, so that lookup is not evidence of an active feed.

Tiles show one price in the preferred currency without a prefix. Listing details retain the original amount and conversion source/time; retained quotes up to four hours old are explicitly marked stale there. Coinbase timing describes retrieval time rather than a trade timestamp. Missing or expired quotes leave the original price unchanged. Preview does not make rate-relay requests.

## Maps and storage

Map markers come only from valid `g` geohash tags in verified listing events. The most specific published cell supplies its centre; a marker is an approximate shared location, not a verified street address. Text such as “Helsinki” is not sent to a geocoder, and the app does not request the viewer’s device location. Listings without coordinates remain available in the grid. The current composer saves location text; choosing a map point for a new listing is not implemented yet.

The map reuses Iris Maps’ immutable OpenFreeMap/OpenMapTiles world archive (native zooms 0–14), light/dark styles, sprites and font ranges through Hashtree. Its root is pinned in `web/src/map/config.js`. MapLibre and PMTiles fetch only needed archive ranges. Every downloaded Hashtree block is checked against its SHA-256 before use or storage; a failed read is reported instead of substituting another map service. OpenStreetMap/OpenFreeMap attribution remains visible.

The browser’s public map cache defaults to **128 MiB**. The native map view defaults to **512 MiB**; both expose 64/128/256/512 MiB limits, current logical usage and Clear cache. Space is used on demand and least-recently-used blobs are evicted. The limit covers stored map blobs, not browser database overhead, transient decoding/GPU memory or downloaded AI models. Keys, conversations, drafts and publication queues are separate from this disposable cache. Clearing map data does not clear those records.

The first native map implementation embeds the shared page at `https://market.iris.to/native-map.html` in WKWebView/Android WebView. It needs an internet connection to load that shell and any uncached map blocks. The native bridge passes only public marker IDs, titles, coordinates and appearance; it exposes no signing keys or private messages. This is not yet a bundled offline map, offline-region downloader or mesh transport. Previously cached blocks can satisfy later reads, but complete offline map availability is not guaranteed.

## AI configuration

In the native apps, choose a provider, endpoint and model in AI settings. The endpoint is the API base: for compatible APIs usually a URL ending in `/v1`, for Ollama its server root, and for Anthropic its API root or `/v1`. HTTPS is required for remote endpoints; local/private-network HTTP endpoints are allowed for local models. Redirects are not followed. Android/iOS network permissions still apply to the chosen endpoint.

Credentials are supplied to the core only for the requested call and are never included in snapshots, saved settings or logs. Curation is an explicit action over at most 12 candidates at a time. A settings change clears previous decisions. The model returns `{ "show": true|false, "reason": "..." }`; invalid responses stop that curation pass and keep undecided listings available. There is always a Show all option. Native local models are accessed through an endpoint such as Ollama; this is separate from the browser worker below.

The browser uses the main search field for both Text and AI search, with inline progress and model options in Settings. Its local worker is adapted from Iris Client under the MIT license. Nothing downloads until the explicit Load & search action is pressed. DeBERTa uses CPU/WASM with an approximately 87 MB download; Qwen 3.5 uses WebGPU with an approximately 551 MB download. Model revisions and weight hashes are pinned in `web/src/feed-filter/models.js`; downloads come from Hugging Face and weight integrity is checked before use. Model files may remain in the browser cache. Stop and unload releases the running worker; it does not erase downloaded cache entries.

Browser listing text and the search are processed locally rather than sent to an AI service. A single word is interpreted as a topic; longer searches retain their stated intent. Each explicit pass reviews the next batch of at most 12 unreviewed listings, with bounded text and decision caches. The reviewed count is shown; unreviewed listings remain visible. DeBERTa offers Balanced (0.5), Relaxed (0.3) and Broad (0.1) score cutoffs; these scores are not calibrated probabilities. Qwen uses its literal yes/no decision. Failures restore visibility, saved listings remain accessible, and Show all reveals filtered results. The models can make incorrect decisions; neither marketplace accuracy nor performance across devices is established. Choosing a local model is an experiment, not a quality guarantee.

## Agent tools

The CLI returns JSON and offers named commands alongside the full action API:

```sh
iris-market --help
iris-market tools
iris-market preview <isolated-data-directory>
iris-market search <profile-directory> "bicycle" --side offer --wait 5
iris-market publish <profile-directory> draft.json --wait 10
iris-market save <profile-directory> <listing-id>
iris-market close <profile-directory> <listing-id>
iris-market contact <profile-directory> <listing-id>
iris-market invite <profile-directory>
iris-market accept <profile-directory> - < private-invite.txt
iris-market send <profile-directory> <peer-id> - < private-message.txt
iris-market mcp <profile-directory>
```

A draft file is a JSON object such as `{"title":"City bicycle","description":"Recently serviced","side":"offer","price":"120","currency":"EUR","location":"Helsinki","category":"Outdoors"}`. `publish` also accepts `-` for stdin. Use the complete `author:identifier` listing ID from search; `contact` derives and verifies its author. `save` toggles the local bookmark. Invitation URLs are private capabilities; `accept` takes a private file or stdin, never the URL as a command argument. `invite` deliberately returns that capability in its JSON output, so keep its output private. `send` accepts inline text or `-`; use stdin for private text to avoid shell history and process arguments.

`--wait` accepts whole seconds from 0 to 60. Search and named network operations default to 5 seconds; `snapshot` defaults to 0, and raw `command` defaults to 2. Search waits for relay discovery before printing its public listing projection. Actions print their final state after the bounded wait; publication and messaging can finish early on relay acknowledgement. Zero skips background waiting; the requested action can still perform its required network lookup. A queued listing or pending message is durably stored and resumes when that profile is opened again. `sent` means a relay acknowledged the encrypted event, not that the recipient read it. Closing a listing and exchanging invitations report `unconfirmed` because this CLI response cannot confirm those events' relay acknowledgements. The wait budget covers background discovery/delivery; a contact lookup additionally uses its own connection and query timeouts. It does not limit time spent reading stdin.

Live CLI/MCP commands require `IRIS_MARKET_SECRET_KEY` from a secure local credential source. Never put an actual key in a command example, repository, shared configuration or shell history. A profile permits one active writer; do not point another process at an open native app's ratchet database. Preview and tool discovery need no credentials and never connect to relays.

MCP provides `market_search`, `market_publish`, `market_save`, `market_contact` and `market_send_message`. Search returns public listing information only. Publication and contacting others require the caller's authorisation; discovering an offer is not permission to act on it. `serve` accepts the full JSON action contract for trusted local integrations. `command <profile-directory> -` accepts one raw action from stdin; `snapshot` and raw actions deliberately return the full local state, including private conversations. Named commands limit output to the requested operation. Errors are JSON on stderr with a nonzero exit status.

## Protocol and privacy

Public offers use NIP-99 kind 30402. Requests use the same shape plus the documented experimental `["market", "request"]` tag; ordinary offers use `["market", "offer"]`. Clients that do not understand that extension may not distinguish requests. Images, title, category, location and price use NIP-99 tags; expiration uses the standard `expiration` tag. Listing IDs are author + addressable identifier. Revisions resolve by creation time and lowest event ID on a tie. Closed/expired winning revisions are retained so older copies do not resurrect listings.

Browser contact discovery follows Iris Chat’s active authorization format: an owner-signed AppKeys roster at kind 37368 authorizes separate device keys, then each device publishes its canonical kind-30078 invitation with `d=double-ratchet/invites/<device-pubkey>` and `l=double-ratchet/invites`. Roster snapshots use their own profile UUIDs; discovery queries the owner and kind rather than an obsolete fixed `d` tag. The buyer verifies signed owner authorization before trusting a device invitation. Private response and message events use metadata-privacy version 2 and identity-unlinkable ratchet keys. This uses the existing NDR wire format, not a Market-specific encryption or linking protocol.

Browser profiles create and restore from local storage without waiting for relay replies. Profile edits and signed listings are saved locally and synchronized in the background, with queued status kept distinct from relay acceptance. Pending listings and the locally signed profile survive reload. Fresh profiles authorize their first chat device locally; importing an existing identity still discovers its signed device roster before encrypted delivery. Remote signing requires the signer's approval, and revocation checks the current roster. Recipient discovery and delivery happen independently of opening a profile or conversation.

Saving a listing leaves its Browse position intact and adds it to Saved. The item’s Buy action prepares an unsent purchase enquiry; Message is available on the seller’s profile. These are enquiries, with no checkout, cart, payment commitment or reservation implied.

The native owner/device adapter uses these canonical records and has passed fresh core tests, strict Clippy and a host-library build. An actual JavaScript↔Rust roundtrip passed in both directions with separate owner/device identities. Swift/Kotlin bindings match that library. The latest native appearance and onboarding changes still need a fresh platform UI build. Privately shared invitation capabilities are never added to public listings.

Private send-only connections, receive subscriptions and one-author discovery scopes are isolated and use anonymous transport identities. Encryption does not remove network-level metadata visibility or protect compromised endpoints. Private message indexes and ciphertext are never included in public listing replay.

## Verification

Run `npm test` in `web` for the current browser suite. Coverage includes signed listings and tombstones, relay history pagination and dense timestamp boundaries, stable grid windows, social graphs, rates, safe Markdown, upload integrity, strict signing scopes, encrypted messaging, and Cashu recovery through the actual SDK with a synthetic fee-bearing mint.

The named CLI passed eleven focused checks, strict Clippy and artifact help/tool-discovery smoke checks. The latest core passed 26 tests and strict Clippy; the host FFI library and generated Swift/Kotlin bindings were refreshed. Actual bidirectional JavaScript↔Rust encrypted messaging passed. An earlier macOS build and Android source compile passed; the latest native UI source changes and optional native Cashu remain unverified on devices.

Browser acceptance uses real public listings for browsing and isolated local fixtures for posting, chat, uploads and wallet actions. It checks grid loading, search, profile sign-in, light/dark layouts, images, maps, and payment recovery across reload. Test messages, listings and funds are never sent to public services. The CPU DeBERTa integration was exercised with both preview and real listing text; incorrect decisions remain possible. The 551 MB WebGPU model was not run during this acceptance.

Full logs and local fixture evidence stay in ignored `work/logs/`; generated native products stay ignored. Key evidence includes `web-takeover-tests.log`, `web-wallet-acceptance-fees.log`, `web-upload-composer-tests.log`, `ndr-interop-js-verify.log` and `macos-build-2.log`. These development checks do not establish signed binary reproducibility, mesh exchange or physical-device background operation.

## Next milestones

1. Complete native wallet and upload interfaces, platform acceptance and editable listings.
2. Add signed native/CLI binary releases, universal links and a verified release manifest.
3. Evaluate ranking and local AI on real marketplace examples, expand graph coverage and add saved matching watches.
4. Integrate FIPS/nearby as backup transport, with separate physical-device tests for direct exchange, multi-hop forwarding and delayed forwarding.
5. Add selective visibility and intermediary introductions with explicit, revocable permissions.
