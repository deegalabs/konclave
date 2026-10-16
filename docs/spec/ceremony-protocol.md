# Spec: Konclave ceremony protocol (DKG + signing over the blind relay)

Status (2026-10-15). **What this document is:** the Konclave ceremony protocol as the code does it
today: the messages a vault's devices, the relay and the hosted coordinator exchange to create a vault
and to sign. **What it is not:** a specification another implementation could follow on its own. Its
limits, each with its plan and status:

- **Not a multi-vendor specification.** It describes one codebase; nothing here was written to be
  implemented independently. Plan: none until a second implementation is asked for. Status: as is.
- **The signing messages carry no version.** Older and newer builds coexist only through optional
  fields (`h`, `sig`) and a distinct kind for the sealed request; a message does not say which rules
  it follows. Plan: a version prefix on the room messages. Status: not started, tracked in
  [#689](https://github.com/deegalabs/konclave/issues/689).
- **No protocol test vectors.** Transaction vectors are in the repository
  (`konclave-wasm/tests/vectors/`, `konclave-signer/tests/vectors/`: proven and signed PCZTs and
  signatures), but nothing here gives vectors for the protocol itself: room messages, a DKG
  transcript, the transcript code. Plan: publish those next to this document. Status: not started,
  tracked in [#690](https://github.com/deegalabs/konclave/issues/690).

Companion to [ADR-0007](../adr/0007-ceremony-security-invariants.md), which records the decision and
the security invariants **I1-I4** this document realizes. It was first written (2026-08-02) as the
target for the security fixes of issues #62/#63/#65.

Implementations: browser client `ui/src/net.ts` (relay transport), `ui/src/signing-machine.ts`
(signing ceremony, driven by `ui/src/background-signer.ts` and `ui/src/background-session.ts`),
`ui/src/screens/NetVault.tsx` (the older `/net` driver), `ui/src/dkg-ceremony.ts` (creation),
`ui/src/net-sign.ts` (sign wire), `konclave-wasm` (DKG + FROST crypto), relay
`relay-server/src/main.rs` + `orchestrator/src/relay.rs`.

## 1. Transport (the blind relay)
- A **room** is named by a code. Messages are `{seq, from, data}`: `seq` monotonic per room, `from`
  an ephemeral per-session tag, `data` an **opaque** byte string the relay never parses.
- Clients **short-poll** with a cursor over `seq`. The relay returns the message list plus a **peer
  count**.
- **The cursor dedups within a session; it does NOT make the room replay-immune.** This line used to
  claim it did, and three separate bugs came from believing it (#354, #356, #358). A cursor that
  starts at 0 replays the whole room, and a room is **permanent per vault**: the signing room is
  `sha256("konclave-sign-s " + S)[:16]` for a vault whose devices hold the per-vault secret `S`
  (#388), or `sha256("konclave-sign " + groupKey)[:16]` for an older open vault, and the relay retains
  512 messages with a one-hour idle TTL.
  So every new reader is handed every previous ceremony.
- **I5 (replay discipline):** every reader of a permanent room MUST declare, per message type, what
  history means to it. Two classes, and mixing them up is what broke:

  | class | types | on history |
  |---|---|---|
  | **replay-safe, and history is REQUIRED** | `armed`, `unarmed`, `rejoin` | process it. A device that reloads mid-payment learns who already signed only by reading the room back. These are scoped by proposal and expire on the wire (#324/#326) precisely so this is safe. |
  | **replay-unsafe** | `sreq`, `s1`, `sp`, `s2`, `signed`, `net-sign-request`, `net-sign-response` | drop it. A finished payment's round-1 commitments fed into a fresh ceremony are what FROST rejects as *"the participant's commitment is incorrect"*, and a previous payment's response injected into a new PCZT is `InvalidExternalSignature`. Nothing is lost: a device that reloads mid-ceremony left its nonces in the page it closed. |

  A **server** reader does this with a cursor: `publish_request` returns the seq it posted at, and
  the poll starts strictly after it. A **client** reader cannot, because it needs history for the
  first class, so the transport reports whether each message is history and the session decides per
  type. Any new message type MUST be placed in one of the two rows above.
- **Where this has bitten:** `RelaySession` starting at 0 (#354, browser), the same fix then starving
  the arming tally (#356, my regression), and `net_orchestrate_send` polling from 0 and injecting the
  previous payment's signatures (#358, helper). Before theorising about a ceremony failure, **read
  the room**: `GET {relay}/api/relay/{room}?since=0&from=diag` settled #354 and #358 in one look,
  after code-reading had produced two wrong hypotheses.
- **I1 (relay is blind):** the relay MUST NOT be able to read any secret, recipient address, or
  amount. It sees room id, tags, sizes, timing and peer count, and in the clear the signing tally
  (`armed`/`unarmed`: seat, proposal id, time, a coarse failure code), which #340 tracks. Every payload carrying spending
  detail MUST be sealed before it is posted (see §4).
- **Hardening (issue #64):** room codes ≥128-bit; per-IP rate limit; room/msg/payload caps; TTL
  eviction; presence pruning; peer count SHOULD NOT gratuitously leak group size.

## 2. Message types (`data`, JSON unless sealed)
Creation (version 2, `v: 2` on `config` and `hello`): `config` (creator→all: n, t, governance g,
creatorName cn, vault name vn) · `hello` (each device: encPub, name) · `commit` (each seat: commitment to its key,
round 1 and nonce) · `reveal` (each seat, after it has seen every commitment: round 1 and nonce) ·
`r2` (DKG round 2, **sealed in WASM** per recipient, only after the code is confirmed) · `vsec` (the
vault's access secret, sealed in WASM and signed with the creator's share). The previous version's
`r1` in a version-2 room stops the ceremony. Other: `rejoin` (restored
device re-announces its seat) · `sreq`/`s1`/`sp`/`s2`/`signed` (signing ceremony) · plus the raw
helper `net-sign-request`/`net-sign-response` (Architecture B).

## 3. DKG + admission (fixes #65 → invariant I4)
Seating today is "the first n distinct tags by relay order, numbered by sorted tag" - a **bearer** model (any code-holder can seat). The spec
REQUIRES **authenticated admission**:
1. **Shared secret (PIN).** The creator sets a PIN alongside the invite code. Each joiner proves
   knowledge of the PIN in the handshake (e.g. the `hello`/round-1 material is bound to
   `KDF(PIN, room)` via an AEAD tag), so a code-only attacker cannot produce a valid seat claim.
2. **Creator admission.** The creator explicitly admits each joiner (sees name + comm-pubkey
   fingerprint, approves) before a seat is granted; unadmitted tags are ignored, not seated.
3. **Out-of-band roster verification.** Before the group key is trusted, every member confirms the
   final roster's comm-pubkey **fingerprints** out of band (safety-number style). An unexpected
   member is caught here.
- **As built (2026-10-12, ADR-0007 amendment).** The three requirements above are realised as: a
  required PIN that derives the room; a 128-bit invite (link or QR); commit-then-reveal of every
  seat's contribution; a 9-character code over the whole transcript, computed in WASM, that every
  member reads with every listed person before round 2; and sealing inside WASM to the keys bound
  into that code. The seats are the first n distinct devices by relay order; anything inconsistent
  before the code is confirmed stops the ceremony. Against a member taking more than one seat the
  check is human (the members must read the code with each listed person). The rule lives in
  `konclave-wasm` `creation` and `ui/src/dkg-ceremony.ts`.
- The vault fingerprint after creation (over the group key) still confirms everyone is in the same
  vault; the code is what confirms who is in it.

## 4. Signing (fixes H1/H2 → invariants I2/I3)
- **I3 (sealed request).** The `net-sign-request` (`sighash`, per-spend `alpha`, `pczt_hex`) MUST be
  ECIES-sealed to the seated devices' DKG keys before it reaches the relay. Cleartext recipient +
  amount MUST NOT transit the relay.

  **How it works today (#63, shipped 2026-08-29).** Each device derives a persistent comms key from its
  share and registers its public half with the coordinator when it unlocks the vault. When a send
  starts, the coordinator seals the `SignRequest` once under a fresh content key and seals that key to
  each registered device (`orchestrator::envelope::seal_to_devices`, called from
  `orchestrator/src/net_send.rs::seal_request_wire`); the relay sees ciphertext. Each device opens it
  with its own comms key before parsing (`ui/src/net-sign.ts::unsealSignRequest`); a request not sealed
  to it, or tampered, is rejected, never half-read. The device that starts the round sends only the
  sighash in its `sreq` for a sealed request, since every device already holds the PCZT, so the
  transaction never crosses the relay in cleartext.
  **Condition, kept as it is:** until every seat of a vault has registered its device key, the
  coordinator sends that vault's request unsealed, the path a device on a build that predates
  registration still understands. Plan: none beyond each member unlocking once on a current build.
  Status: per vault, as members unlock.
- **I2 (on-device sighash binding).** Each signer:
  1. decodes its **own** PCZT and computes the ZIP-244 `sig_digest` locally;
  2. **refuses to sign** unless the locally-computed digest equals the request's `sighash`;
  3. reads each spend's `alpha` from that PCZT (not from an untrusted field);
  4. reads what the PCZT pays with `readPayment` (each output checked against its note commitment,
     #610), displays it, and checks it against the approved lines.
  The bytes signed are derived locally; a wire-supplied `sighash` is only ever *compared*, never
  trusted. This is designed to defeat the transaction-swap; see the status note in §5.
- Multi-spend: one re-randomized FROST ceremony per spend (fresh nonces, that spend's `alpha`),
  sequential; N signatures mapped by action index for the helper's `into_sigs`.
- The **coordinator** is the device whose signature completed the quorum, the same device the room
  names to ask for the send; every device derives it alike from the room's order, and it is fixed for
  the round once the round starts. It starts the round (`sreq`), builds the signing package, aggregates,
  and every device accepts a package or a signature only from it. The `/net` lab page, which has no
  signing tally, keeps seat 1. The coordinator aggregates; the aggregate signature is posted back for the (share-blind)
  helper to inject + broadcast. The helper never holds a share.

## 5. Invariants checklist (must all hold before real-money `/net` broadcast)

> Checklist as of 2026-10-15. I1 holds only once every seat has registered its device key (until
> then the signing request goes out unsealed, #63). I2 also covers the payment: a signing device reads
> it from the transaction and checks it against the approved one (#610). The approved lines it
> compares with still come from the coordinator when it signs (#567, open).
- [x] **I1** relay blind - no secret/address/amount in cleartext on the wire (the relay never parses bodies).
- [x] **I2** on-device sighash recompute + refuse-on-mismatch (#62/#67; primitive proven byte-exact, live-validated 2-tab).
- [x] **I3** SignRequest sealed to the vault's registered devices (#63, 2026-08-29), once every
  seat has registered its device key; until then the coordinator publishes it unsealed, as for I1.
  Shown on mainnet by `047fe6ca…` with the relay-room trace in
  [docs/proof/2026-08-29-relay-blind.md](../proof/2026-08-29-relay-blind.md) ([PROOF](../PROOF.md)).
- [x] **I4** authenticated admission, as amended (ADR-0007, 2026-10-12): required PIN + 128-bit invite + a transcript code every member reads with every other before round 2 + sealing in WASM. Live-validated locally (2-of-2, 2-of-3, a relay that rewrites one view); see §3.
- [x] **I5** replay discipline: every permanent-room reader declares per type whether history applies (§1; #354/#356/#358, live-validated 2-device 2026-08-27, txid `78fe7dfa…`).
- Gate: on a vault's own signing screen I2 and I5 hold, and I1 and I3 hold once every seat has
  registered its device key; I4 holds for vaults created with the version-2 ceremony. The `/net` lab
  page does not have the device's newer checks and has no content check of its own (Known limits in
  `ui/CHANGELOG.md`); use the vault's own signing screen for payments.

## 6. Non-goals (for now)
Non-interactive DKG (Golden, roadmap) · on-chain memo transport as a fallback (Zkool-style, roadmap)
· parallelizing multi-spend ceremonies.
