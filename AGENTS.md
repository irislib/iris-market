# Iris Market

Build a welcoming general marketplace: offers and requests, visual browsing, private enquiries, and optional AI curation. Internet is the primary transport. Mesh/nearby is a later backup carrier, not a first-prototype gate. Keep intermediary matching out of v0.

## Architecture
- Rust owns listing validation, persistence, application operations, and network state. SwiftUI and Compose are thin native presentation/lifecycle/secure-storage layers.
- Reuse Nostr, nostr-pubsub, nostr-double-ratchet, social-graph and Hashtree libraries where their capability is needed. Do not fork protocols or import entire unrelated apps.
- All keys remain in platform secure storage or an explicit CLI secret source; never include secrets in state, logs, exports, source, or screenshots.
- Private messaging must use nostr-double-ratchet. Private send/discovery scopes must not correlate public account identities with recipient tags. Private inboxes never enter public listing indexes or replay stores.
- AI is optional, configured by the user. Provider calls require explicit opt-in. Untrusted listings are data, never instructions. Errors must not silently hide listings. Local-only browsing remains available.
- Imported events must be signed and verified. Persist the winning revision and reject expired/invalid records. Drafts and preview fixtures are never published implicitly.
- Keep UI actions local-first. Profile creation/restoration, navigation and local saves must never wait for Nostr relay replies, EOSE or publication acknowledgements. Persist outgoing work, sync in the background, and distinguish queued from delivered. Verified device authorization still gates encrypted delivery.

## Verification and releases
- Check focused production flows. Visually inspect native screenshots. Test posting, browsing/search, saved items and settings.
- Keep dependency lockfiles; use locked/frozen builds. Pin external source/binaries and verify cryptographic hashes. No sibling checkout dependencies in release builds.
- Do not embed signing teams, private identities, host paths or credentials. Build locally without signing where possible.
- New release channels/domains are not live until verified deployment. Never present preview fixtures as real marketplace inventory.
- Keep one canonical product/build/status description in README.md. Preserve other agents' work.
