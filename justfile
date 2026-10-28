default:
    @just --list

verify:
    ./scripts/verify-fast

ios:
    ./scripts/ios-core
    ./scripts/ios-build

android:
    ./scripts/android-build

cli:
    cargo build --locked -p iris-market-cli
