# Runtime license sources

These notices accompany the ONNX Runtime Web JavaScript/WASM payload from the pinned npm package. They are copied from Microsoft ONNX Runtime commit `8d85527a010e294a26b274749f74294b2a32cec5`:

- `ONNX-RUNTIME-LICENSE.txt`: upstream `LICENSE`.
- `ONNX-RUNTIME-ThirdPartyNotices.txt`: upstream `ThirdPartyNotices.txt`.

The website build also collects license and notice files from the exact npm packages included by esbuild. Each generated site includes `THIRD_PARTY_NOTICES.txt`; model weights remain separately downloaded from their pinned upstream revisions.

`PMTILES-LICENSE.txt` is the BSD-3-Clause license from `protomaps/PMTiles` commit `0cebcaeade40034b86facb6e7da4ec726b9053fb`, the npm registry's `gitHead` for the pinned `pmtiles@4.4.1`. The source file's SHA-256 is `0371c38f338835f7fc13ed71176f3d92144e22c8b736a31cced57adbbeb647b3`. The package tarball integrity remains pinned in `package-lock.json`.

The map and profile dependencies (`@hashtree/core`, `@hashtree/dexie`, `nostr-social-graph`, MapLibre and Dexie) provide their license files in their pinned packages; the build includes them automatically. MapLibre's separately copied workers use the same package license. Iris Chat's adapted relationship projection retains its complete MIT notice in `web/src/profiles.js`; the Rust port includes `crates/market-core/src/IRIS_CHAT_LICENSE.txt`.

Map tiles, styles, sprites and glyphs are fetched from the immutable Hashtree root declared in `web/src/map/config.js`, not distributed inside the website bundle. The map keeps linked OpenStreetMap, OpenFreeMap and OpenMapTiles attribution visible. Changing the dataset requires reviewing its attribution and licensing alongside its pinned root.

`NOSTR-DOUBLE-RATCHET-LICENSE.txt` preserves the MIT notice from `irislib/nostr-double-ratchet` commit `b4b278a05809746848904d4e16b2cfacf74afea9`, whose `ts/package.json` declares the pinned version `0.0.183`. All 67 source files present in the installed npm package were compared byte-for-byte with that commit and matched. The npm metadata does not supply a `gitHead`; the source comparison establishes this notice provenance without claiming a rebuilt bundle match. The license SHA-256 is `51e841f44c5981b71373b68d6b4def2f84151dc90a05b7d25f5f0d87ad1c3f2e`. The exact package tarball integrity is recorded in `package-lock.json`.

`IRIS-CLIENT-LICENSE.txt` preserves the MIT notice from IrisClient commit `686134807fd1da128538c582772bcc1c8000d6a0`. `web/src/media.js` adapts its public imgproxy signature/resize contract; exact proxy-origin matching follows IrisChatRS commit `acaf6062e5c56da6aac28d8284d8c3fff9d0ff79`. Market deliberately omits automatic fallback to the original remote host.
