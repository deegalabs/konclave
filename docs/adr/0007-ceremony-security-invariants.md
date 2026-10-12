# ADR-0007: Ceremony security invariants (blind relay, on-device binding, authenticated admission)

- **Status:** accepted
- **Date:** 2026-08-02
- **Amended 2026-10-01:** we describe Zkool and other projects as peers, not competitors. The comparison
  below is kept as the record of the decision as it was taken.
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
  *Amended 2026-10-12 (decided by the maintainer).* I4 is realised in a different form, recorded
  below under "Amendment: I4 as built".

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

## Amendment: I4 as built (2026-10-12)

**Decision.** I4 ("the invite authenticates the joiner, and every member verifies the roster out of
band before the vault is trusted") is realised by these four pieces instead of the three named above:

1. **A required PIN.** The relay room is derived from the invite AND the PIN; there is no room without
   a PIN. Someone holding only the invite lands in an empty room. The PIN is shared apart from the
   invite and never reaches the relay.
2. **A 128-bit invite.** The invite is 26 characters (130 bits), handed out as a link or a QR.
3. **A code every member compares before anything secret is sent.** Each device commits to its
   contribution, then reveals it; the device's WASM binds the room, the quorum, the governance, the
   vault's name, the creator's name and seat, and every seat's key, name and contribution into one transcript, and
   shows a 9-character code. Each member reads the code with **every listed person**, by voice, and
   confirms only if each reads back the same code. Round 2 does not run, and nothing is sealed, until
   then. The device's confirm call only orders the protocol; the check is the people comparing.
   After round 3 every seat signs, with its new share, that it finished; the vault is registered,
   shown and saved only when every seat has, so no one funds a vault a member does not hold.
4. **Sealing inside WASM.** Round-2 packages and the vault's access secret are sealed by WASM to the
   keys bound into that code; the access secret also carries the creator's share signature.

**Why it replaces the three original pieces.** Creator admission and a per-key fingerprint check what
the creator sees; the code checks what every member sees, which also covers a creator who is not
honest and a relay that shows members different rooms. The PIN inside the handshake is subsumed: the
PIN gates the room, and everything a device consumes is bound into the code.

**What the guarantee is.** Against a relay or a member who changes what members see, the guarantee is
cryptographic: different views give different codes, except with probability about 2^-45, and every
contribution is committed before any is revealed. Against a member who takes more than one seat, it
is **human**: it holds if the members really read the code with every listed person, and the screen
says so. This distinction belongs in any text that describes the ceremony (CLAUDE.md §6.14).

**Exception to CLAUDE.md §6.3 (secrets never in a URL).** The invite may travel as a link. The code is
only in the fragment (after `#`), which browsers never send to a server; the app removes it from the
address bar and history as soon as it reads it; the PIN is never part of a link. A leaked link alone
does not admit anyone, because the PIN is required.

**Existing vaults.** Only creation changes. Vaults created before this keep working for signing,
restore and export. A ceremony between a device on this version and one on the previous version
fails closed: they derive different rooms, and a device that sees a message of the previous version
stops and says to update.

