# ADR-0004: Local HTTP bridge (loopback) between UI and Orchestrator; Tauri packaging becomes roadmap

- **Status:** accepted
- **Date:** 2026-07-01
- **Context:** [ADR-0003](0003-vite-over-nextjs.md) assumed Konclave as a **Tauri desktop
  app**, the UI (static bundle) running inside a Tauri webview, talking to the Orchestrator
  over **IPC**. On reaching Phase 5c (Tauri shell + IPC), the go/no-go validation ("does a
  Tauri window render on the developer's Windows machine via WSLg?") **failed
  reproducibly**: WSLg registers the window (icon in the taskbar) but **does not paint the
  content**, even with software rendering (`LIBGL_ALWAYS_SOFTWARE=1`, X11 backend). This is
  a limitation of this machine's WSLg environment, not of the code.

  Fixing WSLg deeply (WSL/GPU-driver/Windows update) is uncertain and, even if resolved for
  the moment, an unstable WSLg is a **risk to the hackathon's live demo**.

## Decision

Connect **UI ↔ Orchestrator over HTTP on loopback** (`127.0.0.1`), not over Tauri IPC:

- The Orchestrator exposes a **local server** (`konclave serve`) that:
  1. serves the UI's static bundle (`ui/dist`), and
  2. exposes the API under `/api/*` (JSON), wrapping the already-tested core (Store, wallet
     reads, proposal state machine, orchestration of the official binaries).
- The UI, in the browser (or in a future webview), consumes this API **from the same origin**
  (no CORS).
- **Tauri packaging** (a single desktop binary for Windows/macOS/Linux) becomes a
  **roadmap item**, not an MVP one: the Tauri shell reuses exactly this same Orchestrator
  and the same UI.

## Why

- **Demonstrable on Windows without WSLg.** The Windows browser reaches a server listening
  on `127.0.0.1` inside WSL2 (localhost forwarding). It does not depend on WSLg's window
  rendering, which is the broken part.
- **Still local-first and shielded-first.** The server listens **only on loopback**: there
  is no network surface; nothing leaves the device. The product's security property holds:
  it is a local daemon + a local UI, on the same machine.
- **Decouples UI from core.** The same API serves the Tauri webview (packaged product) and
  the browser (demo/development). The Rust core does not change; only the transport layer
  (HTTP instead of `invoke`), a thin shell.
- **No rework.** The UI and the Orchestrator already exist and are tested; only `serve`
  (routing + statics + JSON handlers) is added on top.

## Consequences

- **New surface:** a `konclave` bin in the `orchestrator` crate with the `serve` subcommand
  (`--port`, `--web <dir>`, `--db <path>`). Bind **fixed to `127.0.0.1`**, never `0.0.0.0`.
- **Minimal dependency:** a lightweight blocking HTTP server (`tiny_http`), consistent with
  the synchronous core (rusqlite/subprocesses are blocking), without dragging in an async
  runtime. Routing and handlers live in `server.rs`, testable without opening a socket (a
  `handle(method, path, state) -> Response` function pure enough for destructive tests).
- **HashRouter stays suitable:** the UI's routes live in the fragment (`/#/...`), so the
  server needs no SPA route fallback: it serves real files and `index.html` at `/`.
- **Secrets:** the API **never** exposes shares or sealed material; only public material and
  local bookkeeping (identical to the Store's discipline). Signing endpoints orchestrate the
  FROST ceremony server-side without the key passing through the HTTP layer.
- **Roadmap:** package as a single binary (Tauri on native macOS/Windows, or a local
  webview) for distribution to the non-technical end user: the local-first guarantee does
  not change, only the delivery form. Recorded as packaging debt, not architecture debt.
