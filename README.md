# Iris Market

A general marketplace for things, skills and opportunities. Native iOS and Android apps share a Rust core for offers, requests, bookmarks and private enquiries. A read-only browser app provides visual browsing and share links. AI assistants can use the same native operations through the CLI or MCP.

**Internet first.** Ordinary Nostr servers provide discovery and delivery in this prototype. Nearby Wi-Fi/Bluetooth and FIPS mesh exchange are planned backup carriers. They are not implemented or advertised as working in v0. Intermediary matching ("asking for a friend") is also deferred.

## Current prototype

- SwiftUI iOS and Jetpack Compose Android interfaces, plus a responsive browser app. Appearance can follow the system or use a light/dark override. Preview is explicit and separate from live inventory.
- Signed NIP-99 listings, offer/request search, bookmarks, withdrawal, local persistence and durable publication queues. A server acknowledgement confirms publication; a queued event is not reported as delivered.
- Private enquiries and invitation links using the published `iris-chat-protocol` / `nostr-double-ratchet` engine. Protocol state, message history and the outbox are encrypted at rest. Native account and provider credentials use Keychain / Android Keystore.
- Configurable OpenAI-compatible, Anthropic and Ollama endpoints and model names. AI is disabled by default. Optional yes/no relevance decisions use only selected public listing text and user-provided interests; private conversations are never sent. All listings remain accessible, and failures do not hide undecided listings.
- Browser browsing, local bookmarks and shareable listing details without an account or signing key. Tag filters and verified direct public follows narrow relay queries. Posting and private enquiries use the native app or CLI.
- Optional browser-local AI filtering with explicit model downloads, progress, cancellation and a Show all override. It is experimental; marketplace accuracy is not established.
- Named CLI commands, a local JSON action interface and MCP stdio tools for search, publication, bookmarks, contact and messages.

This is a development prototype, not a released transactional marketplace. It does not implement payments, shipping guarantees, escrow, reputation scoring, background matching agents, linked-device messaging or group conversations. Listing images currently use HTTPS URLs; Hashtree image upload and richer social-graph ranking are subsequent integrations. Native local AI currently uses a configured endpoint; native model weights and a native on-device inference runtime are not bundled. No public App Store, APK or CLI binary release is published.

Web: [market.iris.to](https://market.iris.to) · [App builds and CLI](https://getmarket.iris.to). Source: [GitHub](https://github.com/irislib/iris-market) · [Hashtree](https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-market).

## Repository

- `crates/market-core`: validation, local SQLite data, relay transport, ratchet adapter and AI curation.
- `crates/market-app`: UniFFI entry point shared by native apps.
- `crates/market-cli`: local agent commands and MCP.
- `ios`, `android`: native presentation, secure credentials and lifecycle.
- `web`: read-only browser client, relay/follow validation and optional local AI worker.
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

The local browser opens at `http://127.0.0.1:4173`; add `?preview=1` for sample listings without relay connections. To serve the download page instead, run `MARKET_SITE=downloads PORT=4174 npm run dev`. The build writes `web/dist` and `site/dist`; it also packages the local AI worker and WASM runtime, but no model weights.

The checked-in Cloudflare configurations target the domains above. With an authorised hosting account, deploy the built assets from `web` with the lockfile-installed Wrangler binary:

```sh
./node_modules/.bin/wrangler deploy --config wrangler.jsonc
./node_modules/.bin/wrangler deploy --config ../site/wrangler.jsonc
```

A successful build does not establish deployment. Verify both HTTPS destinations after deployment. No credentials or account identifiers belong in source.

The browser validates signed NIP-99 events before displaying them and retains sold/expired revisions for the life of the page. A `?listing=<author:identifier>` link adds a narrow lookup for that listing beyond recent inventory. Saved IDs, relay preferences and appearance are local to the browser; listings are not a persistent offline browser archive. The Open app link opens an installed native client; it does not yet hand off the selected listing or implement universal links.

Feed filters support up to eight Nostr tags and the direct follows of a public `npub` or hexadecimal key. The follow filter verifies kind-3 events from the configured relays, supports up to 256 followed authors, and preserves the existing feed if lookup fails. It requires no login, performs no second-hop crawl and makes no reputation claim. Public follow and tag queries are visible to the chosen relays.

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

The iOS simulator accepts `--demo`; Android accepts the boolean intent extra `demo=true`. Native Preview uses sample inventory, separate storage and no network calls. The browser uses `?preview=1`, makes no relay connections and disables public-follow lookups in Preview. Explicitly loading a browser AI model can still download its files while viewing sample listings. Sample posts can never be published. Live mode starts with verified relay inventory.

## AI configuration

In the native apps, choose a provider, endpoint and model in AI settings. The endpoint is the API base: for compatible APIs usually a URL ending in `/v1`, for Ollama its server root, and for Anthropic its API root or `/v1`. HTTPS is required for remote endpoints; local/private-network HTTP endpoints are allowed for local models. Redirects are not followed. Android/iOS network permissions still apply to the chosen endpoint.

Credentials are supplied to the core only for the requested call and are never included in snapshots, saved settings or logs. Curation is an explicit action over at most 12 candidates at a time. A settings change clears previous decisions. The model returns `{ "show": true|false, "reason": "..." }`; invalid responses stop that curation pass and keep undecided listings available. There is always a Show all option. Native local models are accessed through an endpoint such as Ollama; this is separate from the browser worker below.

The browser offers an experimental Local AI panel adapted from Iris client under its MIT license. Nothing downloads until Load is pressed. DeBERTa uses CPU/WASM with an approximately 87 MB download; Qwen 3.5 uses WebGPU with an approximately 551 MB download. Model revisions and weight hashes are pinned in `web/src/feed-filter/models.js`; downloads come from Hugging Face and weight integrity is checked before use. Model files may remain in the browser cache. Stop and unload releases the running worker; it does not erase downloaded cache entries.

Browser listing text and filter conditions are processed locally rather than sent to an AI service. Each explicit pass reviews at most 12 listings, with bounded text and decision caches. Failures restore visibility, saved listings remain accessible, and Show all reveals filtered results. The models can make incorrect decisions; neither marketplace accuracy nor performance across devices is established. Choosing a local model is an experiment, not a quality guarantee.

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

Publishing a listing also deliberately enables a separate public contact invitation at kind 30078, `d=double-ratchet/invites/iris-market`. Privately shared invitation links use a different capability and are never added to public listings. A buyer checks the contact record against the signed listing's author before starting a ratcheted conversation.

Private send-only connections, receive subscriptions and one-author discovery scopes are isolated and use anonymous transport identities. Encryption does not remove network-level metadata visibility or protect compromised endpoints. Private message indexes and ciphertext are never included in public listing replay.

## Verification

The earlier core baseline passed 11 tests: signed-event validation and deterministic replacement, expiry/withdrawal across restarts, local outbox/bookmark persistence, Preview isolation, configurable model decisions, encrypted messaging storage, concurrent-writer rejection and public/private invitation separation. Its in-process WebSocket relay test connected two independent profiles, published and discovered a listing, and exchanged a real ratcheted enquiry while inspecting wire traffic. The earlier workspace run passed 12 tests, including the then-current single CLI test; this is historical evidence, not a fresh full-workspace run of the expanded CLI.

The completed named CLI passed 11 focused tests (eight unit and three integration), `cargo clippy --locked -p iris-market-cli --all-targets -- -D warnings`, formatting and an artifact help/tool-discovery smoke check. Offline CLI integration covers publishing, searching, bookmarking, accepting invitations, sending pending private messages and closing listings without contacting relays. The refreshed host artifact was matched to the tested binary by SHA-256.

Native UI acceptance passed three iOS tests across the browsing and final validation runs and three Android tests on the final installed build. Checks cover browsing, search, details, saving, composition, Inbox and AI settings, with light/dark screenshots. Native runtime checks used Preview; live listing and private delivery were exercised through the local WebSocket integration test, and provider responses through a local fixture. No paid provider or physical-device test was performed.

Browser protocol/social checks passed 27 tests covering signatures, replacement/tombstones, shared-link lookup, filtering, bounded relays, public-follow validation, cancellation and connection failures. Ten local AI controller/asset tests cover explicit loading, bounded caching, cancellation, errors, worker disposal, pinned requests and payload integrity. The combined browser suite passed 37 tests. A real DeBERTa CPU browser check loaded the pinned model and filtered eight sample listings for a camera: only the camera remained, and Show all restored all eight. This checks the integration, not general marketplace accuracy. The 551 MB WebGPU model was not run in this app during acceptance. Run `npm test` in `web` for the combined current browser suite.

Screenshots and full build/test logs belong in ignored `work/`; native products belong in ignored `artifacts/`. Evidence includes `work/logs/core-tests.log`, `work/logs/workspace-tests.log`, `work/logs/cli-named-tests.log`, `work/logs/cli-named-clippy.log`, `work/logs/cli-named-artifact.json`, `work/logs/cli-named-artifact-smoke.json`, `work/logs/ios-ui-polish.log`, `work/logs/ios-ui-smoke-accepted.log`, `work/logs/android-ui-final-palette-run.log`, `work/logs/web-social-market-tests.log` and `work/logs/web-feed-filter-tests.log`, `work/logs/web-license-gzip-tests.log`, `work/logs/web-browser-acceptance.json` and `work/logs/web-production-verification.json`. Development checks do not establish mesh, physical-device background operation or release reproducibility.

## Next milestones

1. Complete native pilot feedback, photo upload through Hashtree and editable listings.
2. Add signed native/CLI binary releases, universal links and a verified release manifest.
3. Extend direct-follow filtering with social-graph ranking and saved matching watches, and evaluate local AI on real marketplace examples.
4. Integrate FIPS/nearby as backup transport, with separate physical-device tests for direct exchange, multi-hop forwarding and delayed forwarding.
5. Add selective visibility and intermediary introductions with explicit, revocable permissions.
