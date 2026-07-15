# Deploy: Konclave

How the two hosted pieces of the konclave.app demo are deployed, and how they auto-update from
this repo. (The core app is local-first; these are only the **demo** surfaces.)

## UI demo → Vercel (auto-deploys on push) ✅

The browser demo (`ui/`) is a static Vite build hosted on Vercel at
**https://konclave-demo.vercel.app**.

- **Git integration:** the Vercel project `konclave-demo` is connected to `deegalabs/konclave`.
  A push to `main` triggers a build + production deploy automatically.
- **Project settings** (set via the Vercel API):
  - Root Directory: `ui`
  - Framework: `vite` (build `npm run build` → `dist`)
  - Env var `VITE_RELAY_BASE = https://konclave-relay-production.up.railway.app` (so the built
    UI points `/#/net` at the hosted relay).
- The committed `ui/src/wasm-pkg/` (the pre-built `konclave-wasm`) means the Vercel build needs
  no Rust/wasm toolchain, just `npm ci && npm run build`.

Manual deploy (if ever needed): `cd ui && npm run build && vercel deploy --prod` (project linked).

## Blind relay → Railway ✅

The public blind mailbox (`relay-server/`) is hosted on Railway at
**https://konclave-relay-production.up.railway.app** (project `konclave-relay`). It carries only
opaque/encrypted bytes between devices for the `/#/net` multi-device ceremonies.

- **Deploy:** `cd relay-server && railway up` (builds the `Dockerfile`, a tiny `tiny_http` binary).
- **Auto-deploy from git (native, do once in the dashboard; safest, no token in this public repo):**
  1. Railway → project **konclave-relay** → the service → **Settings → Source**.
  2. **Connect Repo** → `deegalabs/konclave`, branch `main`, **Root Directory: `relay-server`**.
  3. Save. Pushes that touch `relay-server/` now redeploy automatically.
- The relay is stable (~180 lines) and rarely changes, so manual `railway up` is fine too.

## CI (GitHub Actions)

`.github/workflows/ci.yml` gates every push/PR across the whole repo:
- **Rust:** fmt + clippy `-D warnings` + tests on `orchestrator`, `konclave-signer`,
  `konclave-wasm`, `relay-server`.
- **WASM:** `wasm-pack build --target web` for `konclave-wasm` (the browser build).
- **UI:** oxlint + vitest + `tsc -b && vite build`.

## Honest limits

The hosted relay is **not hardened** (no rate limiting; the presence map is unpruned), fine for
the demo, tracked before any serious use. The browser signature over `/#/net` is a **test digest**,
not a broadcast transaction. The real mainnet FROST path runs through the local orchestrator +
engine binaries, not these hosted demo surfaces.
