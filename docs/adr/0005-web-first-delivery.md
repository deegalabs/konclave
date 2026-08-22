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
- **Desktop native (optional, SHIPPED):** a Tauri shell (`src-tauri/`) wrapping the
  `orchestrator` shipped as native installers (Windows / macOS / Linux) at git tag **v0.2.0**
  (2026-08-03, [ADR-0004]); it changes only the delivery form, never the trust model. What remains
  open is live **per-platform hardware** validation (the dev machine's GTK/WSLg window will not
  render).
- **Not Wails / a Go shell.** The backend is Rust (`orchestrator`, `konclave-signer`); a Go
  desktop framework would mean porting Layer 2, and it uses the same WebKitGTK that blocks
  us on WSLg - so it solves nothing here. Tauri stays the native path when we package one.

## Consequences

- **Reach with near-zero packaging cost:** any device with a current browser is a client;
  we skip the entire native-distribution matrix for the core experience.
- **The custody invariant is unchanged across shells:** the share stays on-device and
  encrypted; only a wrapper (Tauri) or a tab (PWA) differs.
- **Status update (2026-08):** the two gaps this ADR listed are now closed:
  - **sign-after-restore** in `/net` is **wired and live-exercised**: a reloaded device restores
    its share from encrypted IndexedDB, rejoins the signing room, re-announces its seat, and signs
    with the restored share (a live two-tab proof observed a restore-then-sign deadlock edge case,
    tracked separately; the fresh-DKG path signs cleanly).
  - a real broadcast from the browser is **proven on mainnet** (Architecture B): a browser-DKG
    vault signed a real Ironwood tx in the browser and the blind helper broadcast it (txid
    `3022420a…`). The remaining depth is a broadcast across **separate physical devices** (proven
    so far as two tabs on one machine).
- **Service-worker discipline:** the SW is network-first and never caches `/api` or `/relay`
  responses, so an online device never runs stale WASM/JS and no sensitive response is
  persisted; the share lives only in encrypted IndexedDB, never in the SW cache.

[ADR-0004]: 0004-local-http-bridge.md
