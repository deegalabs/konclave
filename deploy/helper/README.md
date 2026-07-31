# Deploying the hosted blind helper (`helper-server`)

The [`helper-server`](../../helper-server) crate is the hosted, **share-blind** helper of
ADR-0006 Rung A: it registers a browser-DKG vault by its FROST group key, derives the vault's
Orchard address + UFVK (public material only), keeps a view-only wallet per vault, and — over
Architecture B — builds/proves/broadcasts a spend while the **browsers** sign over the blind
relay. It never receives, derives, or stores a share.

It runs on Railway alongside the blind relay (`konclave-relay` project, `konclave-helper`
service), the same way the relay does.

## The image (`Dockerfile`)

A deliberate tradeoff for the **testnet demo**: the image *bundles* the engine binaries built
from source on the maintainer's machine at the pins in
[`engine/versions.lock`](../../engine/versions.lock), instead of compiling them in-image:

| binary | source pin | role in the helper |
|---|---|---|
| `zcash-sign` | frost-tools `3d2985c` | register: derive Orchard address + UFVK from the group key |
| `zcash-devtool` | Ironwood librustzcash `42ffd0d` | register: view-only wallet init; send: PCZT create/prove/broadcast |
| `konclave-signer` | Ironwood librustzcash `42ffd0d` | send: extract the sighash / inject the browsers' aggregate signature |

A from-source multi-stage build is the **hardening follow-up**; for the demo it would blow
Railway's build limits (librustzcash + orchard + halo2). The binaries are glibc-2.39 (Ubuntu
24.04), so the runtime image is pinned to `ubuntu:24.04`. The helper does **not** need `frostd`
(in Architecture B the browsers run the FROST ceremony over the relay).

## Build the deploy context

The `bin/` the Dockerfile copies is **not** in git (the binaries are ~100 MB and are built out
of repo, matching the pin-not-vendor policy). Assemble it from local builds:

```sh
# helper-server (this repo)
CARGO_TARGET_DIR=~/ktarget cargo build --release --manifest-path helper-server/Cargo.toml

# then gather the four binaries into a deploy context next to this Dockerfile:
mkdir -p ~/konclave-helper-deploy/bin
cp ~/ktarget/release/helper-server            ~/konclave-helper-deploy/bin/
cp ~/ktarget-engine/release/zcash-sign        ~/konclave-helper-deploy/bin/
cp ~/ktarget-ironwood/release/zcash-devtool   ~/konclave-helper-deploy/bin/
cp ~/ktarget-ironwood-signer/release/konclave-signer ~/konclave-helper-deploy/bin/
cp deploy/helper/Dockerfile                   ~/konclave-helper-deploy/Dockerfile
```

Validate locally before deploying:

```sh
cd ~/konclave-helper-deploy
docker build -t konclave-helper:test .
docker run --rm -d --name h -e PORT=4790 -p 4790:4790 konclave-helper:test
curl -s localhost:4790/api/health   # -> {"name":"konclave-helper","status":"ok","vaults":0}
docker rm -f h
```

## Deploy (Railway CLI)

```sh
cd ~/konclave-helper-deploy
railway link -p konclave-relay
railway add --service konclave-helper                       # once
railway volume -s <serviceId> -e <envId> add -m /data       # once: durable KONCLAVE_VAULTS_DIR
railway up --ci -s konclave-helper
railway domain -s konclave-helper                           # mint the public URL
```

The volume mounted at `/data` (= `KONCLAVE_VAULTS_DIR=/data/vaults`) makes registrations survive a
redeploy: `helper-server` reseeds its registry from `<vaults_dir>/<id>/registration.json` at startup,
and a re-register returns the STORED address instead of re-deriving a fresh diversified one. The
image runs as root so the (root-owned) volume is writable — acceptable for this blind demo helper
(no secret in the container); dropping to non-root + chowning the volume is a hardening follow-up.

## Configuration (env vars)

All are public tooling paths / endpoints — nothing secret. Defaults suit the testnet demo.

| var | default | meaning |
|---|---|---|
| `KONCLAVE_HELPER_ADDR` | `0.0.0.0:4780` | bind address (the CMD wires Railway's `$PORT` in) |
| `KONCLAVE_NETWORK` | `test` | `main` or `test` (drives address validation + derivation) |
| `KONCLAVE_LIGHTWALLETD` | `testnet.zec.rocks:443` | lightwalletd for the view-only wallets |
| `KONCLAVE_ZCASH_SIGN` / `KONCLAVE_DEVTOOL` / `KONCLAVE_SIGNER` | `/usr/local/bin/...` | engine binary paths |
| `KONCLAVE_VAULTS_DIR` | `/home/helper/vaults` | per-vault view-only wallets + send scratch |

> `KONCLAVE_VAULTS_DIR` is on the container's ephemeral filesystem. A redeploy loses the
> view-only wallets (the vaults must re-register); fine for the demo. Attach a Railway volume to
> persist them for real use.

## API

See [`helper-server/src/main.rs`](../../helper-server/src/main.rs). Read paths never leak the
UFVK or account (audit M1); `POST /api/vault/send` defaults `dry_run` to **true** — the caller
must pass `dry_run:false` to broadcast, so a single call never fires funds.
