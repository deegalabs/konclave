# src-tauri/: Konclave native shell (Tauri 2.0)

**Status: UNVALIDATED SCAFFOLD. Not built, not run, not validated in this repo's environment.**

This directory is honest groundwork for packaging Konclave as a native app. It has never
compiled or launched here: the dev machine's WSLg/GTK webview does not paint a window
(see [../docs/adr/0004-local-http-bridge.md](../docs/adr/0004-local-http-bridge.md)), and no
macOS / iOS / Android build host was available. Treat every command below as "what a
developer on the right hardware would run", not as something proven.

The full rationale, the browser-vs-Tauri boundary, the share-persistence design, and the
per-platform matrix live in [../docs/TAURI-PLAN.md](../docs/TAURI-PLAN.md). Read that first.

## What this shell is

A thin Tauri 2.0 wrapper that loads the **already-built** Vite/React UI (`../ui/dist`) in a
native OS webview. The entire browser-proven app carries over unchanged: the `/net` DKG +
FROST flow, the relay/helper protocol, and the `konclave-wasm` crypto all run inside the
webview exactly as they do in a browser tab. The shell adds only one native capability today:
three `invoke` commands (`keychain_set_share` / `keychain_get_share` / `keychain_delete_share`
in `src/lib.rs`) that let the UI persist its already-encrypted per-device share in the **OS
keychain** instead of browser IndexedDB. Plaintext key material never crosses that boundary.

## Files

| File | Purpose |
|---|---|
| `Cargo.toml` | Crate + Tauri 2.x deps; `lib` crate-type set for mobile targets. |
| `build.rs` | Standard `tauri_build::build()`. |
| `src/lib.rs` | App builder + the three keychain commands. Has one offline unit test (base64 round-trip). |
| `src/main.rs` | Desktop entry point that calls `run()`. |
| `tauri.conf.json` | `frontendDist` -> `../ui/dist`; window; CSP is `null` in the scaffold (must be tightened). |
| `capabilities/default.json` | Core default permissions only. |

## Prerequisites (all hosts)

- Rust (repo uses 1.95) and the Tauri CLI: `cargo install tauri-cli --version "^2"` (or `npm i -g @tauri-apps/cli@2`).
- Build the UI at least once so `../ui/dist` exists: `npm --prefix ../ui ci && npm --prefix ../ui run build`.
- Generate app icons once (bundling requires them): `npx tauri icon path/to/icon-1024.png`.

## Per-target commands and honest status

Run from `src-tauri/` (or repo root with `--config src-tauri/tauri.conf.json`).

### Desktop

```sh
# Dev (hot-reload against the Vite dev server):
cargo tauri dev

# Release bundle for the current OS:
cargo tauri build
```

- **Windows** (`.msi` / `.exe` via WiX/NSIS), PLAN-ONLY. Needs a Windows host with MSVC
  build tools + WebView2. Not run here.
- **macOS** (`.app` / `.dmg`), NEEDS HARDWARE. Needs a Mac with Xcode command-line tools;
  signing/notarization need an Apple Developer ID. Not run here.
- **Linux** (`.deb` / `.rpm` / AppImage), SCAFFOLDED but BLOCKED on THIS machine. Needs
  WebKitGTK (`libwebkit2gtk-4.1-dev`); the WSLg webview does not render here (ADR-0004), so
  even a successful compile could not be validated visually on this box.

### Mobile

```sh
# Android (needs the crate's lib target, already set):
cargo tauri android init
cargo tauri android dev      # or: cargo tauri android build

# iOS:
cargo tauri ios init
cargo tauri ios dev          # or: cargo tauri ios build
```

- **Android**, NEEDS HARDWARE/SDK. Needs the Android SDK + NDK, `ANDROID_HOME`/`NDK_HOME`,
  and Rust android targets (`aarch64-linux-android`, ...). Not installed here.
- **iOS**, NEEDS HARDWARE. Needs macOS + Xcode + an Apple Developer account for signing, and
  Rust ios targets (`aarch64-apple-ios`, ...). Impossible to validate off a Mac.

## The one thing that IS checkable offline

`src/lib.rs` has a single pure unit test (`base64_round_trips`) guarding the byte-wrapping at
the keychain boundary. It exercises no Tauri and no keychain (neither is available here). Even
that test has not been compiled in this environment, because pulling the Tauri dependency tree
was out of scope for laying down the scaffold. It is written to pass; it is not proven to.
