# Deploy: Konclave

The three hosted pieces, how each one ships, and how to tell what is actually running.

> **This file used to call these "demo surfaces" and say the browser signature was "a test digest,
> not a broadcast transaction".** Both stopped being true. The browser path signs and broadcasts real
> mainnet transactions - `docs/PROOF.md` lists nineteen, including sends signed in a browser, a
> payroll, and a ceremony across separate machines. ADR-0005 records the web as the delivery that
> carries the product. Corrected 2026-09-21.

| Piece | Ships by | Identifies itself as |
|---|---|---|
| **The app** (`ui/`) | every merge to `main` → Vercel | the commit, in the footer |
| **Coordinator** (`helper-server/`) | by hand, `railway up` | `/api/health` → `helper_commit` |
| **Blind relay** (`relay-server/`) | by hand, `railway up` | `/health` → `source_digest` |

**Verify by BEHAVIOUR, never by the deploy log.** Every one of these has shipped a deploy that
reported success while serving something else. Each section below says what to ask and what the
answer should be.

`node scripts/check-deployed.mjs` runs the service probes for you - it asks the two hand-deployed
services whether the behaviour a fix introduced is actually there, rather than whether a commit
merged. Pass `--vault=<64 hex>` when a probe needs a real vault; without one it says so instead of
guessing, and an ambiguous 404 reads as "behind" until you do.

## The app → Vercel (automatic)

Static Vite build at **konclave.xyz** / **konclave-demo.vercel.app**, project `konclave-demo`
connected to `deegalabs/konclave`. A push to `main` builds and promotes to production.

- Root Directory `ui`, framework `vite`, build `npm run build` → `dist`
- `VITE_RELAY_BASE = https://konclave-relay-production.up.railway.app`
- `ui/src/wasm-pkg/` is committed, so the build needs no Rust toolchain

**Verify:** the footer shows `v<version> · <commit>`. Compare the commit with `main`.

> A member on an installed PWA may keep an older build for a while: a new service worker only
> replaces the old one once every tab is closed. The footer commit is the answer to "do I have the
> fix?", not the version number, which only moves when a release is cut.

## Coordinator (helper) → Railway (by hand)

**https://konclave-helper-production.up.railway.app**, service `konclave-helper` in project
`konclave-relay`.

The full recipe, including the engine binaries and the reason they are not in git, is in
[deploy/helper/README.md](deploy/helper/README.md). The short form:

```sh
CARGO_TARGET_DIR=~/ktarget cargo build --release --manifest-path helper-server/Cargo.toml
# assemble ~/konclave-helper-deploy/ fresh (four binaries + Dockerfile + entrypoint.sh)
cd ~/konclave-helper-deploy && railway up --ci -s konclave-helper
```

Two things that have each cost a day:

- **`railway redeploy` re-uploads the OLD image.** It is not a rebuild. The path is always: build,
  swap the binary, `railway up`.
- **The deploy context is `~/konclave-helper-deploy/`, never `deploy/helper/` in this repo**, and it
  is assembled fresh every time. On 2026-09-07 a `bin/` found lying there held a binary older than
  the CORS fix whose absence had taken every private read down that morning.

**Verify:**

```sh
curl -s .../api/health   # -> {"helper_commit":"<sha>", ...}
```

The commit must be the one you built. A build from a modified tree reports `<sha>-dirty`, which is
the difference between an identifier and a guess.

## Blind relay → Railway (by hand)

**https://konclave-relay-production.up.railway.app**, service `konclave-relay`. It carries only
sealed bytes between devices.

```sh
cd <repo root> && railway up --ci -s konclave-relay   # context is the REPO ROOT
```

The build context is the repository root, not `relay-server/`, because the crate depends on
`konclave-http`; `.dockerignore` keeps the upload to the two crates it needs, and Railway is told
`RAILWAY_DOCKERFILE_PATH=relay-server/Dockerfile`.

**Verify:** `curl -s .../health` returns `source_digest`. It cannot report a commit - Railway builds
it from an uploaded directory with no git checkout, so a commit stamp would read `unknown` every
time, which is worse than nothing because it looks like an answer. The digest answers the question
that matters: *is the running relay built from THIS source?* **It is not an attestation** - anyone
who can replace the binary can make it report anything.

## CI

`.github/workflows/ci.yml` gates every push and PR: Rust fmt + clippy `-D warnings` + tests, the
WASM browser build, the UI (oxlint + vitest + `tsc -b && vite build`), the relay image, and the
changelog gate (`scripts/changelog-gate.mjs`, which decides WHICH changelog a change must touch).

## Honest limits

**Replicas are not a switch, and turning one on would break both services.** The relay keeps its
rooms in an in-process `Mutex<HashMap<..>>`: two replicas are two different sets of rooms, so two
devices in one ceremony would land on different replicas and never see each other - and which
replica a device lands on is not something the ceremony controls. The coordinator holds vault state
on a durable volume at `/data`, and a Railway volume attaches to one instance; two processes writing
the same registry would corrupt it. Replicating either one means moving that state out first
(shared store for the relay's rooms, a database for the coordinator's registry). Worth doing when
load or availability demands it; neither does today, and the 2026-08-27 outage that looked like an
availability problem was a serial request loop, fixed by a worker pool (#384).

**The services answer on `*.up.railway.app`.** `relay.konclave.xyz` and `helper.konclave.xyz` are
not set up. Doing it is a migration rather than a setting: `railway domain` on each service, CNAMEs
in DNS, and then `orchestrator/src/csp.rs`, `ui/src/helper.ts` and Vercel's `VITE_RELAY_BASE` all
have to name the new origin - **with the old one still allowed**, because an installed PWA keeps
calling whatever URL it was built with until it updates. A hard switch would cut off every device
that had not reloaded.

**The deployed engine is not reproducible from `main`.** `zcash-sign`, `zcash-devtool` and
`konclave-signer` are built out of repo and copied into the image; `engine/versions.lock` on `main`
pins older versions than the binaries actually deployed. That is the real content of the #259 debt,
and it is why the release record (`## [x.y.z]` in `CHANGELOG.md`) writes down what each service was
ANSWERING when a version was cut rather than what it should have been.
