# src-tauri/

**Placeholder: Tauri packaging is on the roadmap, not built yet.**

The plan was a Tauri desktop shell hosting the Rust backend. During integration the
WSLg/GTK window would not render on the dev machine, so we pivoted to a **loopback HTTP
bridge**: `konclave serve` binds `127.0.0.1` and serves the Rosto bundle plus a JSON API
wired to the tested core. Same local-first guarantee (keys never leave the device), only
the transport differs. See [docs/adr/0004-local-http-bridge.md](../docs/adr/0004-local-http-bridge.md).

Where the code actually lives today:

- **Backend / orchestrator (Layer 2):** `orchestrator/`, holding the proposal state machine,
  validation, wallet, ceremony, store, sealing, and the loopback bridge.
- **FROST↔PCZT bridge:** `konclave-signer/`.
- **Frontend (Layer 3, "Rosto"):** `ui/`.

Packaging the app as a single Tauri desktop binary is a post-submission roadmap item; it
changes only the delivery, not the architecture.
