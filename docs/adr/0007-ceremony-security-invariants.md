# ADR-0007: Ceremony security invariants (blind relay, on-device binding, authenticated admission)

- **Status:** accepted
- **Date:** 2026-08-02
- **Context:**
  A security audit of the blind relay and the browser FROST ceremonies (DKG + signing) found that
  three security properties the product *claims* are not yet *enforced on-device*. All three live on
  the money path and must hold before `/net` moves real funds.

  1. **Transaction-swap (H1).** In signing, the device signs the `sighash` it *receives* over the
     relay; it does **not recompute** the ZIP-244 sig_digest from its own PCZT (the recompute is a
     stub). A compromised helper or coordinator device can therefore display a benign PCZT (via
     `describeOutputs`) while the `sighash` corresponds to an attacker transaction with the same
     spends/alphas but attacker outputs. The devices sign; the aggregate signature verifies for the
     *evil* transaction; funds go to the attacker. This breaks the central "the helper is blind and
     cannot steal" invariant. (Zkool, the closest competitor, *does* recompute from its own PCZT.)
  2. **Metadata disclosure (H2).** The signing `SignRequest` (`sighash` + `alpha` + `pczt_hex`) is
     posted to the relay in **plaintext**; the PCZT decodes to the cleartext recipient address and
     amount. Unlike the DKG round-2 packages (ECIES-sealed), the signing request is not sealed, so a
     curious relay operator or room-code holder learns who a shielded vault pays and how much.
  3. **Bearer invite (#65).** The DKG invite *is* the relay room code and is the only gate. Seating
     is "first n by sorted tag" with no joiner authentication, no creator admission, and no
     out-of-band identity check; human names are self-asserted. An attacker who obtains or guesses
     the (~40-bit) code can seat themselves as a **real vault member** (a signer), or grief the DKG.
     They still cannot steal the key (round-2 is sealed) or forge a signature (no share), so the
     attack is on *creation* and *griefing*, not silent draining of an existing vault.

  What already holds (keep): the relay never parses message bodies; DKG round-2 secrets are
  ECIES-sealed device-to-device; nonces/shares never leave the browser; the loopback bridge is
  Host-gated with a constant-time CSRF token; the hosted relay has real DoS hardening.

## Decision

Adopt these as the **enforced** ceremony security invariants. The protocol is specified in
[docs/spec/ceremony-protocol.md](../spec/ceremony-protocol.md); this ADR records the decision and
the *why*.

- **I1 - Relay is blind.** The relay sees only opaque bytes plus unavoidable envelope metadata
  (room id, ephemeral tags, sizes, timing). It never sees a secret, an address, or an amount. Any
  payload that would reveal spending detail MUST be sealed before it reaches the relay.
- **I2 - On-device sighash binding (fixes H1).** Every signer recomputes the ZIP-244 sig_digest from
  **its own** PCZT and **refuses to sign** unless it equals the requested `sighash`. The signed
  bytes are derived locally, never trusted from the wire. *No real-money `/net` broadcast until this
  lands.*
- **I3 - Sealed coordination payloads (fixes H2).** The `SignRequest` is ECIES-sealed to the
  devices' DKG keys (reusing the round-2 `sealTo` machinery), so I1 covers spending metadata too.
- **I4 - Authenticated admission (fixes #65).** The invite authenticates the *joiner*, not just the
  room: a creator-set shared secret (PIN) is mixed into the handshake so a code-only attacker cannot
  seat; the creator explicitly admits each joiner; and every member verifies the final roster's
  pubkey fingerprints **out of band** (safety-number style) before the DKG is trusted. Room codes
  are ≥128-bit.

**Sequencing:** I2, I3, I4 are the "ceremony-security batch" (issues #62, #63, #65; hardening #64),
landed **before** the Dashboard-driven send (#49) broadcasts real money (#51). They do not block the
merge (#47), the honesty pass (#52), or non-money features.

## Consequences

- **Security:** closes the transaction-swap and metadata-leak holes and turns the bearer invite into
  an authenticated, verifiable admission. Post-fix, our relay is strictly stronger than the
  on-chain-memo alternative except on "no server at all."
- **UX cost:** a PIN + a creator-admission step + a one-time fingerprint confirmation are added to
  creation; the tarja/preview already surfaces the resolved send target for I2.
- **Implementation:** all four use primitives already in the repo (`sealTo`/ECIES, `describeOutputs`,
  ZIP-244 digest, higher-entropy codes). No new crypto dependency.
- **Honesty:** until I2 ships, docs/CLAIMS must keep the `/net` broadcast as "verified, not
  broadcast for real money" and not claim the helper cannot steal.
