# ADR-0006: Browser-native vault (the /vault inside /net), via a staircase toward no operator

- **Status:** accepted
- **Date:** 2026-07-31
- **Context:**
  Konclave today runs in two disconnected worlds. The **vault app** (`/dashboard`, `/pay`,
  `/proposals`, `/ledger`, `/members`, `/receive`) talks to a **local Orchestrator**
  (`konclave serve`, [ADR-0004](0004-local-http-bridge.md)) over the loopback `/api/*` bridge.
  The **`/net`** flow holds the FROST shares in the browser and coordinates a DKG plus signing
  over a **blind relay** (Architecture B), but it only does DKG and signing: to actually build,
  prove and broadcast a transaction, a **developer runs a CLI** (`konclave net-send`).

  That CLI dependency is the problem. A real user cannot run a Rust binary, and should not depend
  on an operator running one. So `/net` is a developer demo, not a product: the user has to hand
  a developer the room code and the group key, and the developer executes the send on a machine.
  The trust breaks exactly there.

  An independent review of the ZecHub FROST projects (2026-07-29) names the meaningful next
  milestone precisely: distribute the shares across **independently-controlled devices** and carry
  that path to a **confirmed transaction id**. None of the six projects had reached it. Our own
  browser-signed broadcast (txid `3022420a...`, 2026-07-30) proves the distributed browser-signing
  **protocol** broadcasts, but it was two browser tabs on **one machine**, not separate devices.

## Decision

Build toward a **browser-native vault**: the vault interface operates on the browser-DKG vault, so
the `/vault` lives **inside** the `/net` world. Walk there on a **staircase** so value ships early
and trust deepens over time:

- **Rung A (self-service on the web).** Replace the developer CLI with a **hosted blind helper**: a
  service that, given a vault's **view-only UFVK** and a signing request, builds and proves the
  PCZT, publishes the request to the blind relay, waits for the browsers to sign, injects, and
  broadcasts. It is **blind to shares** (it never sees one). The `/net` app registers the vault with
  the helper and reuses the existing vault screens against the helper's `/api/*`. Now anyone opens
  `/net` on two devices and operates the vault on the web, with no one handing a key to a developer.

- **Rung B (shrink the helper's trust).** Move the light logic into the browser: the proposal state
  machine, ZIP-317 and address validation, the ledger, note selection and **PCZT construction** in
  WASM. The helper is reduced to **prove plus broadcast** of a browser-built PCZT.

- **Rung C (no operator).** Move ZK **proving** and broadcast into the browser (halo2 in WASM, a
  light-client sync, and a dumb gRPC-web broadcast proxy). The browser does create, prove and
  broadcast on its own. No service ever sees a share or builds the transaction. End-state: "your key
  lives on your phone, the platform never has access."

Accompanying decisions:

- **Two modes coexist.** The **local** mode (`konclave serve`) is unchanged. The **relay/browser**
  mode is what this ADR evolves. The vault UI is a single bundle that adapts its backend
  (local Orchestrator, hosted helper, or in-browser).
- **Membership is a share on a device** (browser today, hardware wallet such as a Keystone PCZT
  signer tomorrow). **Funding is any Zcash wallet** paying the vault's Orchard address (already
  supported at `/receive` with a QR and a ZIP-321 URI). There is no "connect your existing wallet to
  become a member": a normal single-key wallet cannot be one of the FROST shares.
- **Fallback without the relay:** QR and copy-paste, per the original closed decisions.
- **A verifiable ceremony record** (inspired by the ZecSafe submission) accompanies each
  authorization: intent, PCZT digest, who approved, the sighash, and the txid, replayable and
  checkable off-chain. This is how FROST attribution, which the chain cannot prove, becomes
  reproducible evidence.

## Invariants (never violated on any rung)

1. A key share never leaves the device.
2. Nothing that can see a secret is hosted. The relay carries only opaque or already-encrypted
   bytes; the helper sees only view-only material.
3. Every fund-moving action has a preview and an explicit confirmation.
4. Each signer confirms the destination and amount from the PCZT before signing (independent signer
   review), so no signer trusts a coordinator-supplied recipient or value.
5. Shares are never co-located, not even temporarily.

## Trust model per rung

| Rung | Who builds the tx | Who proves | Who broadcasts | What the hosted side can see | Can it move funds alone |
|---|---|---|---|---|---|
| A | hosted helper | hosted helper | hosted helper | view-only graph (never a share) | no (needs the quorum's browser signatures) |
| B | browser | hosted helper | hosted helper | a browser-built PCZT (never a share) | no |
| C | browser | browser | dumb proxy | nothing (opaque relay + pass-through) | no |

At every rung the helper cannot spend without the quorum's signatures, because it never holds a
share. What deepens across A to C is how little the hosted side sees at all.

## Why

- The value and the differentiator both land at **Rung A**: self-service on the web plus a
  cross-device broadcast to a confirmed txid, which the independent review says none of the six
  reached. B and C deepen trust but are not prerequisites for that value.
- The one research-grade unknown, **in-browser proving** (halo2 in WASM), is isolated to Rung C and
  can be spiked in parallel without blocking A or B.
- It reuses what exists: the vault screens already speak `/api/*`; the hosted helper exposes the same
  surface, per vault and blind, so the UI changes little.

## Consequences

- New hosted component (the blind helper) with its own threat model and a "no-secrets" audit; it is a
  semi-trusted service (blind to shares, sees the view-only graph) until Rung C removes it.
- The full plan, task tree, milestones (M1 = Rung A + cross-device mainnet txid), and risks are the
  working execution plan; this ADR is the durable decision. Related: [ADR-0004](0004-local-http-bridge.md)
  (the local bridge this reuses), [ADR-0002](0002-pczt-frost-bridge.md) (the FROST to PCZT bridge the
  helper drives), [ADR-0005](0005-web-first-delivery.md) (web-first delivery).
- Known engine caveat carried in: the Ironwood single-note dummy issue (upstream librustzcash #2777)
  is worked around with `create-max` until the engine is bumped past commit `51385a15`.
