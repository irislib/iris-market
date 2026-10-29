# Iris Market

Command-line client and MCP server for Iris Market, a marketplace using signed Nostr listings and private encrypted enquiries.

```sh
cargo install iris-market --version 0.1.0 --locked
iris-market --help
iris-market tools
iris-market preview ./market-preview
```

Tool discovery and preview need no credentials and do not connect to relays. Live commands require `IRIS_MARKET_SECRET_KEY` from a secure local credential source. Never put a secret key in command arguments or shell history. Use a separate profile directory for each active client; do not open a native app's profile concurrently.

The CLI returns JSON. It supports listing search, publication, saved items, private enquiries, orders and an MCP server. Publishing and contacting others require the caller's authorization. Read the [project documentation](https://github.com/irislib/iris-market#agent-tools) before using live commands.

This is a development prototype. Licensed under MIT.
