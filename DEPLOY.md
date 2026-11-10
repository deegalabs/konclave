# Deploy: Konclave

The three hosted pieces, how each one ships, and how to tell what is actually running.

> **This file used to call these "demo surfaces" and say the browser signature was "a test digest,
> not a broadcast transaction".** Both stopped being true. The browser path signs and broadcasts real
> mainnet transactions - `docs/PROOF.md` lists them, including sends signed in a browser, a
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
- `VITE_RELAY_BASE = https://relay.konclave.xyz` (read from the live bundle on 2026-10-03; builds
  before the custom domain carried `https://konclave-relay-production.up.railway.app`)
- `VITE_HELPER_BASE = https://helper.konclave.xyz` (read from the live bundle on 2026-11-04)
- **The desktop release builds with the same two values**, written as plain env in
  `.github/workflows/desktop-release.yml` because the workflow cannot read Vercel's (#664). Change
  them in both places together; the release fails when its bundle does not carry both
  (`scripts/check-desktop-bundle-cli.mjs`).
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
REV=$(git rev-parse --short HEAD)
CARGO_TARGET_DIR=~/ktarget-$REV cargo build --release --manifest-path helper-server/Cargo.toml
CARGO_TARGET_DIR=~/ktarget-$REV cargo build --release --manifest-path konclave-signer/Cargo.toml
# assemble ~/konclave-helper-deploy/ fresh: our two binaries from ~/ktarget-$REV, the two engine
# tools whose sha256 engine/versions.lock records (checked with sha256 -c), Dockerfile, entrypoint.sh
# the relays this coordinator may publish to (#270; values per environment in the table below),
# set BEFORE the first `railway up` of a build that reads them
railway variables -s konclave-helper --set "KONCLAVE_RELAY_BASES=<the environment's relays>"
cd ~/konclave-helper-deploy && railway up --ci -s konclave-helper
```

A deploy that changes the engine needs a full volume backup first, wallets included: the wallet
migration is one-way, and an older engine cannot sync a migrated wallet. See
[deploy/helper/README.md](deploy/helper/README.md).

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

**The coordinator publishes a signing request only to the relays it is configured with (#270).**
`KONCLAVE_RELAY_BASES` lists them, as comma-separated `https://host[:port]` origins, and a send that
names any other relay is refused. There is no default: with the variable unset or empty, every send
is refused (503), and the boot log says so. Set it on the service before the first `railway up` of a
build that reads it (the command block above); setting a variable can restart the deployment that is
running, which ignores it. Then verify by behaviour, with no vault needed:

```sh
curl -s -X POST .../api/vault/proposals/x/send -H 'content-type: application/json' \
  -d '{"vault":"x","relay_base":"https://example.invalid","room":"ROOM2345","dry_run":false}'
# (Without "dry_run":false the answer is 400 "this coordinator runs no practice send", before the relay is looked at.)
# 400 "only talks to its own relay": configured. 503 "no relay configured": the variable is missing.
# 404 "no such vault": a build from before #270.
# Then once per relay name the app sends (the table below), expecting 404 "no such vault": a 400
# here means the variable spells that relay differently from the app, and every real send fails.
curl -s -X POST .../api/vault/proposals/x/send -H 'content-type: application/json' \
  -d '{"vault":"x","relay_base":"https://relay.konclave.xyz","room":"ROOM2345","dry_run":false}'
```

Spell each value exactly as the app sends it (`VITE_RELAY_BASE`): the match is exact, so `:443` or a
trailing dot in the variable would refuse every send.

| environment | `KONCLAVE_RELAY_BASES` |
|---|---|
| production | `https://relay.konclave.xyz,https://konclave-relay-production.up.railway.app` |
| staging | `https://konclave-relay-staging.up.railway.app` |

Production lists both names of the same relay because an installed PWA keeps calling the URL it was
built with until it updates (see the paragraph on service names below).

**Which address the limits count a request under (`KONCLAVE_TRUSTED_PROXY_HOPS`).** Both servers,
the coordinator and the relay, take the client's address from `X-Forwarded-For`. Unset, they take
the first hop, as they always have. Set to a whole number from 0 to 8, they trust that many proxies:
`n` takes the `n`th value from the right of the chain, across every header line, and `0` ignores the
header and uses the socket. A value they do not understand stops the server at boot (exit code 2),
and the boot log says which rule is in force; so does the health answer (`trusted_proxy_hops`,
`null` for the default), at `/health` on the relay and `/api/health` on the coordinator.

Set it from what the platform is seen to do, never from a guess. Each server logs, once per length
and per process, the first request whose header carried that many values (`forwarding: first request
with N X-Forwarded-For value(s)`, with "9 or more" as the last bucket), as a count and never an
address. Measure **every hostname that reaches the service** (the custom domain and the platform's own
name are separate paths), right after a deploy:

1. Send one request with no `X-Forwarded-For`.
2. Send one with exactly 5 values (`-H 'X-Forwarded-For: 192.0.2.1, 192.0.2.2, 192.0.2.3, 192.0.2.4, 192.0.2.5'`).
3. Send one with the same 5 values split over two header lines (`-H 'X-Forwarded-For: 192.0.2.1, 192.0.2.2'
   -H 'X-Forwarded-For: 192.0.2.3, 192.0.2.4, 192.0.2.5'`).
4. Read the service's log for the new `forwarding:` lines. A request that adds no line arrived with a
   length already seen; the smallest length ever logged is a floor (nothing arrives with fewer values
   than the platform adds). Once the number is set, read the boot line, or the health
   answer's `trusted_proxy_hops`, to confirm it.

What the counts mean, per hostname:
- **0, 5+k, 5+k (k at least 1): the platform appends k values** to what the client sent. Set the
  setting to `k`. This is the case the setting is for. Then confirm it before relying on it: from
  one machine, within ten seconds, send more requests than the per-address limit (300 on either
  server) to a route the limits count (on the coordinator `GET /api/vault?vault=` followed by 64
  zeros, on the relay `GET /api/relay/probe?since=0&from=probe`; never a health route, which is never
  counted), each with a different made-up LAST `X-Forwarded-For` value taken from `192.0.2.0/24` or
  `198.51.100.0/24`, first as one header line and then as two. Since they all come from your
  address, they must start answering `429` at the limit (on the relay a single `from` tag reaches its
  own limit of 150 first). If they never do, or answer `429` well before it, unset the setting and
  stop: the platform did not add its values where the count suggested.
- **c, c, c (the same count, c at least 1): the platform rebuilds the header** and the client's values
  never reach the server. Leave the setting unset (or set `c`, which picks the same value when c is 1).
- **0, 0, 0: the platform strips the header.** Every request counts under the socket address, which is
  the proxy's, so all clients would share one budget under `0`. Do NOT set `0`; leave it unset and
  report it: the address would have to come from another header, which this release does not read.
- **0, 5, 5: the platform passes the client's header and adds nothing.** No value of the header can be
  trusted and the socket is the proxy: no setting makes it safe. Stop and report.
- **Anything else** (a "9 or more" line, a count that differs between steps 2 and 3, or two hostnames
  of one service that disagree): stop. No single number serves two paths that add different counts,
  and counts cannot show whether the platform appends to the first header line or the last.

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

**The services answer on two names each.** `relay.konclave.xyz` and `helper.konclave.xyz` are live
and the production app is built against them; checked on 2026-10-03, they report the same
`source_digest` and `helper_commit` as `konclave-relay-production.up.railway.app` and
`konclave-helper-production.up.railway.app`. The `*.up.railway.app` names stay allowed - in
`orchestrator/src/csp.rs` and in the coordinator's `KONCLAVE_RELAY_BASES` - because an installed
PWA keeps calling whatever URL it was built with until it updates, and a hard switch would cut off
every device that had not reloaded. Narrowing to one name is a later, deliberate change.

**The deployed engine is reproducible from recorded sources, not bit for bit.** `konclave-signer`
is built from the commit being deployed; `zcash-devtool` from an upstream rev plus the patch in
`engine/patches/` (committed on 2026-10-03, after the build that ships, and checked to reproduce
that build's source tree; see `[source.zcash-devtool]` in `engine/versions.lock`); and `zcash-sign`
from frost-tools at a recorded rev. Build paths end up in the binaries, so a rebuild on another
host compiles the same source and hashes differently; the hash that ships is the one the lock
records. Since #120 the lock pins the released crate line, and since 2026-10-04 (v0.10.0)
production runs it; until then it ran the OLDER (July) engine. That was
why the release record (`## [x.y.z]` in `CHANGELOG.md`) writes down what each service was ANSWERING
when a version was cut rather than what it should have been.
