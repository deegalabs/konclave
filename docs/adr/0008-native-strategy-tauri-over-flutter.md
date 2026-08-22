# ADR-0008: Native strategy - one React UI (web + Tauri), not a second Flutter UI

- **Status:** accepted
- **Date:** 2026-08-02
- **Context:**
  Konclave is **browser-native**: a React UI plus the Rust crypto core compiled to WASM
  (`konclave-wasm`), running in any browser with zero install - the wedge no comparable project has
  (an ecosystem scan found no other in-browser threshold-FROST shielded signer). The open question
  is how to add durable key custody and a native feel (desktop, and eventually mobile) without losing
  that wedge. The closest competitor, Zkool 2, is **Flutter-only** (Dart UI over a Rust core via
  `flutter_rust_bridge`) and has **no browser build**.

  The crypto core is shareable across every target regardless of UI: the same Rust compiles to WASM
  for the web/webview and to a native library for an FFI host. The real fork point is the **UI**:
  - **Tauri** wraps the *same* React UI in a native webview + a Rust backend + the OS keychain. One
    codebase covers web, desktop, and (Tauri 2) mobile; it reuses `konclave-wasm` as-is in the
    webview.
  - **Flutter** is a *second* UI in Dart. It would reach the Rust core via FFI (native compile, not
    our WASM), giving a polished native mobile feel - at the cost of building and maintaining two
    UIs. This is Zkool's path; they gave up the browser to take it.

## Decision

Keep **one React UI**: **web as the core, Tauri for desktop and native mobile**, with the OS keychain
for durable share custody. Do **not** build a second (Flutter) UI unless a native-mobile UX becomes a
hard requirement that PWA + Tauri 2 cannot meet - and even then, weigh it against maintaining two
UIs. The keychain bridge already exists on `feat/tauri-shell` (a `ShareStore` trait, tested headless).

## Consequences

- **One codebase, wedge preserved.** Web (zero-install) stays the differentiator; Tauri extends the
  *same* React + WASM to desktop with the keychain, solving the IndexedDB-eviction custody risk.
  Mobile is covered by the PWA now and Tauri 2 later, without a UI rewrite.
- **Cost.** Tauri's mobile story is younger than Flutter's; if that bites, revisit - but the default
  avoids a permanent two-UI maintenance tax.
- **Crypto stays single-source.** `konclave-wasm` (WASM) for web/webview; the same Rust could compile
  native if a future FFI host ever needs it. No fork of the security-critical core.
- Supersedes the earlier "Tauri deferred" framing (ADR-0004) only in direction: Tauri is the chosen
  native path, still gated on building per platform on real hardware.
