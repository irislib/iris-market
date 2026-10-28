# Iris Market for Android

Native Jetpack Compose presentation around the shared Rust application core.
The live market uses Internet connections. Preview is explicit and makes no network requests.

## Build

Requires JDK 17+, Android SDK 36, NDK 28.2.13676358, the Rust Android target,
and the repository's pinned Rust toolchain. Set `ANDROID_HOME` or `ANDROID_SDK_ROOT`.
From the repository root, run `scripts/android-build`.

The script verifies the wrapper JAR; the wrapper verifies the pinned Gradle 9.3.1 archive.
Gradle dependencies use reviewed locks and SHA-256 verification metadata. The initial
release owner creates these with `--bootstrap-locks`, reviews the dependency inputs,
and commits them; routine builds use strict verification.

`--skip-rust` consumes existing Kotlin bindings in `android/app/build/generated/uniffi`
and `target/aarch64-linux-android/debug/libiris_market_app.so`. No Gradle task silently
starts a Rust build. Set `CARGO_TARGET_DIR` consistently to reuse an explicitly owned cache.

## Preview and checks

Launch `MainActivity` with the Boolean Intent extra `demo=true` to open sample inventory.
The persistent Preview badge and disabled publication distinguish it from live inventory.
Use the profile view to switch between Preview and the live market.

`scripts/android-ui-check emulator-PORT` installs the two debug APKs and runs focused
Compose flows on an explicitly allocated emulator. It refuses physical devices.
Capture and inspect screenshots after those flows before accepting visible changes.

## Secrets and privacy

The app encrypts its account secret and optional model-provider API keys with a non-exportable
Android Keystore AES-GCM key. Ciphertext is stored atomically under `noBackupFilesDir`;
Android backup is disabled. Preview uses a separate account and data directory.
Generated native bindings and Rust libraries stay in build outputs.

AI use is optional. The provider, endpoint and exact model are configured by the user;
selected public listing text and interests are sent only after opt-in. The settings snapshot
never stores the model key. HTTP is allowed for deliberately configured local model endpoints;
remote listing photos are HTTPS-only and bounded in size. Mesh transport is outside v0.
