# ADR-0005: Web-first delivery - the browser is the universal distribution

**Status:** Accepted (2026-07-27)

## Context

Konclave must reach ordinary treasurers on whatever device they already have -
Windows, macOS, Linux (many distros), Android, iOS. The naive path is a native app per
platform, which drags in the whole packaging matrix: `.msi` / `.dmg` / `.deb` / `.rpm` /
AppImage / Flatpak / Snap, plus two mobile app-store pipelines. For a solo project that is
a large, recurring maintenance cost that has nothing to do with the product.

Two facts about Konclave's architecture change the calculus:

1. **The cryptographic core is WASM.** `konclave-wasm` runs DKG, the confidential channel,
   and FROST signing **inside the browser**. The `/net` flow already performs a full
   cross-device DKG + signing ceremony over the blind relay entirely in-browser (Phase 9),
   proven phone-to-phone over the internet on the hosted relay (Phase 10, Marco 6).
2. **The share never needs the host OS.** A device holds its share encrypted at rest
   (`ui/src/storage.ts`, encrypted IndexedDB), signs with it locally, and only public /
   encrypted material crosses the wire. The heavy, fund-moving steps (build / prove /
   broadcast the PCZT) are trustless and stay **off-device** via the helper (Architecture B,
   [ADR-0004] + the `net_send` protocol): the helper cannot move funds without the quorum.

Given (1) and (2), a modern browser is already a complete Konclave client.

## Decision

**Deliver web-first. The browser + WASM + a blind relay is the universal distribution;
native shells are optional wrappers, not requirements.**

- **Web (primary):** the static `ui/` bundle + `konclave-wasm`, talking to a hosted blind
  relay. One artifact serves every OS and both mobile platforms. No per-distro packaging.
- **Installable (PWA):** a web app manifest + a minimal, update-safe service worker make it
  installable to a home screen / desktop and give an offline app shell - without any store.
- **Mobile = the browser / PWA.** The phone holds its share (encrypted IndexedDB), signs
  in-browser via WASM over the relay; build/prove/broadcast stay off-device (helper).
- **Desktop native (optional, deferred):** a Tauri shell wrapping the `orchestrator` for a
  native installer remains on the roadmap ([ADR-0004]); it changes only the delivery form,
  never the trust model. Deferred while the dev machine's GTK/WSLg window will not render.
- **Not Wails / a Go shell.** The backend is Rust (`orchestrator`, `konclave-signer`); a Go
  desktop framework would mean porting Layer 2, and it uses the same WebKitGTK that blocks
  us on WSLg - so it solves nothing here. Tauri stays the native path when we package one.

## Consequences

- **Reach with near-zero packaging cost:** any device with a current browser is a client;
  we skip the entire native-distribution matrix for the core experience.
- **The custody invariant is unchanged across shells:** the share stays on-device and
  encrypted; only a wrapper (Tauri) or a tab (PWA) differs.
- **Honest gaps that remain before "mobile = browser" is fully closed:**
  - **sign-after-restore** in `/net` - restoring a share from IndexedDB works; reconnecting
    to the relay and signing again after a reload is the pending piece.
  - a real broadcast Orchard transaction from the browser (today `/net` signs a real Orchard
    sighash and verifies; the broadcast loop is Architecture B, wired but not yet live).
- **Service-worker discipline:** the SW is network-first and never caches `/api` or `/relay`
  responses, so an online device never runs stale WASM/JS and no sensitive response is
  persisted; the share lives only in encrypted IndexedDB, never in the SW cache.

[ADR-0004]: 0004-local-http-bridge.md
