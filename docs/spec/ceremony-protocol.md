# Spec: Konclave ceremony protocol (DKG + signing over the blind relay)

Status (2026-10-15). **What this document is:** the Konclave ceremony protocol as the code does it
today: the messages a vault's devices, the relay and the hosted coordinator exchange to create a vault
and to sign. **What it is not:** a specification another implementation could follow on its own. Its
limits, each with its plan and status:

- **Not a multi-vendor specification.** It describes one codebase; nothing here was written to be
  implemented independently. Plan: none until a second implementation is asked for. Status: as is.
- **The signing messages carry no version.** A device on an older build and one on a newer build cannot
  tell from a message which rules it follows. Plan: a version prefix on the room messages. Status: not
  started, not tracked in an issue yet.
- **No test vectors.** The fixtures the test suites use (a proven transaction, its sighash, a DKG
  transcript) are not published as vectors. Plan: export them next to this document. Status: not
  started, not tracked in an issue yet.

Companion to [ADR-0007](../adr/0007-ceremony-security-invariants.md), which records the decision and
the security invariants **I1-I4** this document realizes. It was first written (2026-08-02) as the
target for the security fixes of issues #62/#63/#65.

Implementations: browser client `ui/src/net.ts` (relay transport), `ui/src/screens/NetVault.tsx`
(ceremony driver, to be factored into `ui/src/signing.ts`), `ui/src/net-sign.ts` (sign wire),
`konclave-wasm` (DKG + FROST crypto), relay `relay-server/src/main.rs` + `orchestrator/src/relay.rs`.

## 1. Transport (the blind relay)
- A **room** is named by a code. Messages are `{seq, from, data}`: `seq` monotonic per room, `from`
  an ephemeral per-session tag, `data` an **opaque** byte string the relay never parses.
- Clients **short-poll** with a cursor over `seq`. The relay returns the message list plus a **peer
  count**.
- **The cursor dedups within a session; it does NOT make the room replay-immune.** This line used to
  claim it did, and three separate bugs came from believing it (#354, #356, #358). A cursor that
  starts at 0 replays the whole room, and a room is **permanent per vault**: the signing room is
  `sha256("konclave-sign " + groupKey)` and the relay retains 512 messages with a one-hour idle TTL.
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
- **I1 (relay is blind):** the relay sees only room id, tags, sizes, timing, and peer count. It MUST
  NOT be able to read any secret, recipient address, or amount. Every payload carrying spending
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

  **Implementation plan (the one open invariant).** The seal primitive already exists:
  `konclave-wasm`'s `sealTo` (X25519 -> HKDF-SHA256 -> XChaCha20-Poly1305), the same machinery that
  seals DKG round-2 - native for the helper and via wasm-bindgen for the devices, so the helper's
  seal and the device's unseal interoperate (one crate). Remaining, in order:
  1. **Device-key registration (#63 handshake).** `orchestrator/src/helper.rs::register_vault` today
     knows only the group key. Extend registration so each seated device also hands the helper its
     DKG encryption pubkey (already established at DKG time); the roster's pubkeys are verified out of
     band by I4's fingerprint, so a wrong key is caught.
  2. **Seal on publish (helper).** In `orchestrator/src/net_send.rs::publish_request`, serialize the
     `SignRequest` canonically and `seal` it per recipient (one envelope per seated device, like
     round-2) before it touches the relay - `pczt_hex`/`sighash`/`alpha` never transit in cleartext.
  3. **Unseal on receive (device).** In `ui/src/net-sign.ts::parseSignRequest` /
     `signing-machine.ts::tryHelperRequest`, unseal with this device's DKG key before parsing; a
     request not sealed to this device, or tampered, is rejected - never half-interpreted.
  4. **Seal the inter-device `sreq` too.** Seat 1's `sreq` (sighash + pczt) also transits plaintext
     today; seal it device-to-device (seat 1 already holds the others' DKG pubkeys from round-2).
  5. **Backward-compat.** Negotiate by capability (a sealed request is a distinct kind/field); until
     every device advertises a key, fall back to the current plaintext path, so the live-proven `/net`
     flow never breaks mid-rollout.
  6. **Validation gate.** Ship behind a flag and validate on a live **2-device** `/net` ceremony
     (seal -> relay -> unseal -> sign -> broadcast); a relay capture must show no cleartext
     address/amount before the default flips. This is money-path, so it lands as its own PR with the
     live check - never rammed into an unrelated change.
- **I2 (on-device sighash binding).** Each signer:
  1. decodes its **own** PCZT and computes the ZIP-244 `sig_digest` locally;
  2. **refuses to sign** unless the locally-computed digest equals the request's `sighash`;
  3. reads each spend's `alpha` from that PCZT (not from an untrusted field);
  4. displays the PCZT outputs (`describeOutputs`) that correspond to the digest it will sign.
  The bytes signed are derived locally; a wire-supplied `sighash` is only ever *compared*, never
  trusted. This is designed to defeat the transaction-swap; see the status note in §5.
- Multi-spend: one re-randomized FROST ceremony per spend (fresh nonces, that spend's `alpha`),
  sequential; N signatures mapped by action index for the helper's `into_sigs`.
- The **coordinator** (seat 1) aggregates; the aggregate signature is posted back for the (share-blind)
  helper to inject + broadcast. The helper never holds a share.

## 5. Invariants checklist (must all hold before real-money `/net` broadcast)

> Checklist as of 2026-10-15. I1 holds only once every seat has registered its device key (until
> then the signing request goes out unsealed, #63). I2 also covers the payment: a signing device reads
> it from the transaction and checks it against the approved one (#610).
- [x] **I1** relay blind - no secret/address/amount in cleartext on the wire (the relay never parses bodies).
- [x] **I2** on-device sighash recompute + refuse-on-mismatch (#62/#67; primitive proven byte-exact, live-validated 2-tab).
- [x] **I3** SignRequest sealed to the seated devices (#63, 2026-08-29), proven by a mainnet send with
  the relay blind to the payment, txid `047fe6ca…` ([PROOF](../PROOF.md)).
- [x] **I4** authenticated admission, as amended (ADR-0007, 2026-10-12): required PIN + 128-bit invite + a transcript code every member reads with every other before round 2 + sealing in WASM. Live-validated locally (2-of-2, 2-of-3, a relay that rewrites one view); see §3.
- [x] **I5** replay discipline: every permanent-room reader declares per type whether history applies (§1; #354/#356/#358, live-validated 2-device 2026-08-27, txid `78fe7dfa…`).
- Gate: I1-I5 hold on a vault's own signing screen. The `/net` lab page does not have the device's
  newer checks and has no content check of its own (Known limits in `ui/CHANGELOG.md`); payments use
  the vault's own signing screen.

## 6. Non-goals (for now)
Non-interactive DKG (Golden, roadmap) · on-chain memo transport as a fallback (Zkool-style, roadmap)
· parallelizing multi-spend ceremonies.
