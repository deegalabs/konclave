# Deploying the hosted blind helper (`helper-server`)

The [`helper-server`](../../helper-server) crate is the hosted, **share-blind** helper of
ADR-0006 Rung A: it registers a browser-DKG vault by its FROST group key, derives the vault's
Orchard address + UFVK (public material only), keeps a view-only wallet per vault, and - over
Architecture B - builds/proves/broadcasts a spend while the **browsers** sign over the blind
relay. It never receives, derives, or stores a share.

It runs on **Zcash mainnet** (`KONCLAVE_NETWORK=main`, lightwalletd `zec.rocks:443`) on Railway
alongside the blind relay (`konclave-relay` project, `konclave-helper` service), the same way the
relay does. It currently serves 8 live vaults (re-counted 2026-09-06 from the boot log; the "~23" here was stale by a census).

## The image (`Dockerfile`)

A deliberate tradeoff: the image *bundles* the engine binaries built from source on the
maintainer's machine, instead of compiling them in-image:

| binary | role in the helper |
|---|---|
| `zcash-sign` | register: derive Orchard address + UFVK from the group key |
| `zcash-devtool` | register: view-only wallet init; send: PCZT create/prove/broadcast |
| `konclave-signer` | send: extract the sighash / inject the browsers' aggregate signature |

**Engine pins - deployed vs `engine/versions.lock`.** Measured inside the container on
2026-10-01, the **deployed** helper runs the **July** engine: `zcash-devtool` (2026-07-26) and
`konclave-signer` (2026-07-28) built on librustzcash `42ffd0d` (pczt 0.7), and `zcash-sign`
(2026-07-09) from frost-tools #587. The released line (pczt 0.9.3 / `zcash_client_backend` 0.24.0)
ran from 2026-08-24 to 2026-09-21 and was replaced by the `cp` steps below, which copy from
directories that still hold July builds (#522). Moving `main` and then production onto the released
line is #120; until it is deployed, do not treat this image as being on the released line.

A from-source multi-stage build (librustzcash + orchard + halo2) would exceed Railway's build
limits, so the binaries are built out of band. They are glibc-2.39 (Ubuntu 24.04), so the runtime
image is pinned to `ubuntu:24.04`. The helper does **not** need `frostd` (in Architecture B the
browsers run the FROST ceremony over the relay).

## Build the deploy context

> **The deploy context is `~/konclave-helper-deploy/`, never `deploy/helper/` in this repo.** The
> Dockerfile lives here; the binaries do not. A `bin/` under this directory is a leftover, and on
> 2026-09-07 one was found holding a `helper-server` older than #466 - the CORS fix whose absence
> took every private read down that morning. A `railway up` from here would have shipped it. Assemble
> the context fresh each time from the commands below; do not reuse a directory you find lying about.

The `bin/` the Dockerfile copies is **not** in git (the binaries are ~100 MB and are built out
of repo, matching the pin-not-vendor policy). Our two binaries are built from the commit being
deployed, in a target directory named after it, so nothing comes from a directory that outlived the
build it holds. That is the mistake #522 records: until #120 the engine was copied from long-lived
target directories, and on 2026-09-21 that put a July engine back in production.

```sh
# Our binaries, from the commit being deployed (run in this repo, on a clean tree).
REV=$(git rev-parse --short HEAD)
CARGO_TARGET_DIR=~/ktarget-$REV cargo build --release --manifest-path helper-server/Cargo.toml
CARGO_TARGET_DIR=~/ktarget-$REV cargo build --release --manifest-path konclave-signer/Cargo.toml

mkdir -p ~/konclave-helper-deploy/bin
cp ~/ktarget-$REV/release/helper-server   ~/konclave-helper-deploy/bin/
cp ~/ktarget-$REV/release/konclave-signer ~/konclave-helper-deploy/bin/

# The two external tools are pinned in engine/versions.lock ([source.zcash-devtool],
# [source.frost-tools]), each with the sha256 of the build that is allowed to ship. Copy the binary
# whose sha256 matches that record; if none on this host does, rebuild it from the recorded source.
cp <zcash-devtool whose sha256 engine/versions.lock records> ~/konclave-helper-deploy/bin/zcash-devtool
cp <zcash-sign whose sha256 engine/versions.lock records>    ~/konclave-helper-deploy/bin/zcash-sign
cp deploy/helper/Dockerfile ~/konclave-helper-deploy/Dockerfile

# Before `railway up`: every binary must be the one you meant.
sha256sum ~/konclave-helper-deploy/bin/{helper-server,konclave-signer,zcash-devtool,zcash-sign}
strings ~/konclave-helper-deploy/bin/konclave-signer | grep -oE 'pczt-[0-9.]+|zcash_client_backend-[0-9.]+' | sort -u
```

The `strings` line must name the line `engine/versions.lock` pins (today `pczt-0.9.3` and
`zcash_client_backend-0.24.0`). A signer built on a git rev prints paths under `checkouts/` instead,
and that is the July engine. After the deploy, record the four sha256 under `[deploy_build]` in
`engine/versions.lock` in the same pull request that deployed them, and check the container:

```sh
railway ssh -- stat -c %s /usr/local/bin/konclave-signer /usr/local/bin/zcash-devtool /usr/local/bin/zcash-sign /usr/local/bin/helper-server
```

Those are read-only, and the sizes must equal the files you uploaded.

Validate locally before deploying:

```sh
cd ~/konclave-helper-deploy
docker build -t konclave-helper:test .
docker run --rm -d --name h -e PORT=4790 -p 4790:4790 konclave-helper:test
curl -s localhost:4790/api/health   # -> {"name":"konclave-helper","status":"ok"}
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
container runs as a **non-root** user (#265): `entrypoint.sh` enters as root only to `chown` the
Railway volume so it is writable, then `exec gosu konclave` drops to the dedicated, unprivileged
`konclave` system user before running the (share-blind) helper. No secret ever lives in the
container.

## Configuration (env vars)

All are public tooling paths / endpoints - nothing secret. The defaults below are the mainnet
deployment values.

| var | default | meaning |
|---|---|---|
| `KONCLAVE_HELPER_ADDR` | `0.0.0.0:4780` | bind address (the CMD wires Railway's `$PORT` in) |
| `KONCLAVE_NETWORK` | `main` | `main` or `test` (drives address validation + derivation) |
| `KONCLAVE_LIGHTWALLETD` | `zec.rocks:443` | lightwalletd for the view-only wallets (mainnet default; `testnet.zec.rocks:443` for testnet) |
| `KONCLAVE_ZCASH_SIGN` / `KONCLAVE_DEVTOOL` / `KONCLAVE_SIGNER` | `/usr/local/bin/...` | engine binary paths |
| `KONCLAVE_VAULTS_DIR` | `/data/vaults` | per-vault view-only wallets + send scratch (per the Dockerfile) |

> With the Railway volume mounted at `/data` (see "Deploy" above), `KONCLAVE_VAULTS_DIR=/data/vaults`
> lives on **durable** storage, so registrations persist across redeploys. Without a volume,
> `/data` is on the container's ephemeral filesystem and a redeploy loses the view-only wallets (the
> vaults must re-register), so the volume is required for real use - and is attached on the mainnet
> deployment.

## API

See [`helper-server/src/main.rs`](../../helper-server/src/main.rs). Read paths never leak the
UFVK or account (audit M1). A send is solicited only for an **approved proposal** via
`POST /api/vault/proposals/{id}/send` (refused unless the proposal is `ready`), which defaults
`dry_run` to **true** so a single call never fires funds. The old ungoverned `POST /api/vault/send`
(arbitrary destination, no approval) was removed in #387.
