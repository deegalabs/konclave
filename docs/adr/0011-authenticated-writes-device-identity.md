# ADR-0011: Authenticated governance writes via a per-device identity key (not the FROST share)

- **Status:** accepted
- **Date:** 2026-08-31
- **Context:**
  The hosted helper's governance **write** endpoints are unauthenticated (#288, `severity-critical`).
  Anyone who knows a vault id can POST to them. Stage 1 landed and helps but does not close the hole:

  1. **Roster check (shipped).** `handle_vote` rejects a `member` not in `load_members(...)`, and
     `claim_members` is now write-once (a different roster on an already-rostered vault is refused).
     This stops fabricated *names* and wholesale roster replacement.
  2. **Still open — per-seat authenticity.** Nothing binds a write to the *device that owns that
     seat*. A member (or anyone holding the per-vault secret `S`, post-#388) can still **impersonate
     another member**: POST an approve/refuse under a real roster name, or `POST /members/rename` a
     seat they do not own (the "only your own seat" rule lives only in the client). On a vault with
     **no roster yet**, a first-claim race lets an attacker set the roster before the real members do.
  3. **Amplified by #281.** The signing gate's `isApproved` is still stubbed (`() => true` in
     `VaultSigner.tsx`), so a forged approval count is not caught before a device contributes a share.
     Write-auth (#288) and the approval-binding (#281) are the two halves of the same money-path hole.

  What already holds (keep): #388 gates the helper's *reads* behind `readKey = HKDF(S,"read")`, so an
  id-only outsider can no longer even learn the member names; #63 gives every device a persistent
  **X25519 comms key** (derived from its share) that the helper stores per vault and uses to seal the
  SignRequest. The residual threat is therefore **insider impersonation** and the **first-claim race**,
  not the anonymous-outsider brick the original issue described.

  **The design question** is how a device proves it owns a seat when it writes. Three options were on
  the table: (B) a symmetric per-vault `writeKey = HKDF(S,"write")` in a header; (A1) sign the write
  with the **FROST share** itself (reusing the `signRoomMsg` primitive from #401, verified against the
  verifying shares); (A2) a **dedicated per-device signing key**, separate from the FROST share.

  We checked what the Zcash Foundation actually does. In `ZcashFoundation/frost-tools`, each
  participant holds a dedicated **`CommunicationKey`** (an X25519 key, used in a `snow` Noise channel,
  `Noise_K_25519_ChaChaPoly_BLAKE2s`) that authenticates and encrypts coordination messages. It is
  **separate** from the `key_package` (the FROST signing share); participants are identified by their
  communication pubkey. The FROST share signs the threshold transaction and nothing else. This is the
  standard hygiene: do not overload the signing key with application-level authentication.

## Decision

Adopt **A2**: authenticate governance writes with a **per-device identity key**, separate from the
FROST signing share, matching the Zcash Foundation's frost-client pattern.

- **D1 - The device identity.** Each device already has an X25519 comms key derived from its share
  (#63, used for sealing). Extend that identity with an **Ed25519 write-signing key**, also derived
  from the share by HKDF under its own domain. One device identity, two sub-keys: X25519 for sealing,
  Ed25519 for signing. The FROST share stays reserved for the threshold signature only.
- **D2 - Signed write envelope.** Each governance write (`approve`, `refuse`, `rename`) carries
  `seat`, `ts`, `nonce`, and an Ed25519 `sig` over a canonical message
  `"konclave-write-v1\0" || vault_id || action || target || ts || nonce` (where `target` is the
  proposal id for a vote, or `old || new` for a rename). Binding to the proposal id + action + a nonce
  prevents replay across proposals and actions.
- **D3 - Helper verification.** The helper recomputes the message, verifies the signature with
  `ed25519-dalek` against the **registered write pubkey for that seat**, checks the nonce is unused,
  then maps seat → member. A `rename` is accepted only for the seat that signed it, which closes the
  rename-hijack. Bind the **first roster claim** to a signed device key too, closing the first-claim
  race.
- **D4 - Registration, authenticated, in the record that already exists.** A device registers its
  Ed25519 write pubkey with its seat, **sealed over the #63 channel**, so the helper cannot forge the
  seat↔key binding and an outsider cannot register a key in a seat's place. It is public material (a
  pubkey), and it **extends the existing `device-keys.json`** (`load_device_keys`/`add_device_key`,
  written for #63) with the seat and the write key. Do **not** add a second registry beside it: two
  records of "which device belongs to this vault" would drift, and the #63 consumer already reads
  that file.
- **D6 - One rule, called by both backends (Hexagonal / Ports & Adapters).** The verification
  (recompute the canonical message,
  check the signature, reject a used nonce, map seat → member, and the fail-open gate) lives **once**
  in the `orchestrator` crate, next to `read_authorized` - the #388 read gate, which is already shared
  this way. Both callers use it: the hosted `helper-server` (which already depends on `orchestrator`
  and imports `claim_members`, `rename_member`, `load_members`, `read_authorized`) and the local
  bridge (`orchestrator::server::vote_proposal`, which lives inside the same crate).

  The reason is practical, not doctrinal: written twice, the rule gets **fixed in one place and
  forgotten in the other**, and the same user action then behaves differently on web and on desktop.
  That drift is already recorded in #349 and is what #215 asks us to avoid. (The established name for
  this shape is Hexagonal / Ports and Adapters; it is a useful reference, not a standard this repo is
  adopting wholesale.)

  What stays per-backend is **transport and presentation only**: HTTP parsing, status codes and error
  shape, the bridge's own session/CSRF gate, local logging. This is also what `proposal.rs`,
  `validation.rs`/`address.rs`, `money.rs`, `reconcile.rs` and `read_authorized` already do, so the
  new rule is joining an existing habit rather than introducing a scheme.

  The alternative - authenticate only the internet-facing helper and leave the loopback bridge as it
  is - was rejected. It would close the exposed hole but leave the two paths behaving differently for
  the same user action, with no single test pinning the rule. That is the drift already recorded in
  #349 and the opposite of #215's "same complete solution on every path". Centralising the rule pays
  that debt down instead of adding to it.
- **D5 - Fail-open migration.** A vault with no registered write keys keeps accepting unauthenticated
  writes (the current behaviour), so existing vaults never break; once the seats register (converge on
  unlock, as #63/#388 do), the helper **requires** signed writes. Extend #406 ("Protect this vault")
  to register the write keys, so read-gate (#388) and write-auth (#288) migrate in one guided flow.
  No key change, no re-creation, funds untouched.

**Rejected alternatives.**

- **B (symmetric writeKey).** The helper would hold the secret it verifies against, so a compromised
  or hostile helper could **forge** any member's vote. Violates "the helper cannot act for you." Out.
- **A1 (sign with the FROST share).** Cryptographically safe via domain separation, and it reuses the
  #401 room-signing primitive, but it **overloads the signing key** with application auth, which is
  exactly what the ZF's frost-client avoids. Its only advantage was reuse of #401 - and #401 itself is
  a candidate to migrate onto the device identity (see below). No lasting benefit over A2.

## Consequences

- **Security:** closes insider impersonation, the rename-hijack, and the first-claim race; the helper
  holds only public keys and cannot forge a write. Pairs with #281 (bind the signing gate to the
  approval record) to close the money-path governance hole end to end.
- **Key hygiene / ZF alignment:** the FROST share signs threshold transactions and nothing else;
  coordination auth is a separate identity, as in `frost-client`.
- **UX / product:** a per-device identity is the legible interface concept - "your devices", each a
  seat, viewable and revocable - which is cleaner than "sign with your share" and serves the
  palm-of-the-hand goal.
- **Implementation:** `ed25519-dalek` verification is trivial in Rust; registration extends the
  existing #63 device-key store; the client derivation mirrors `device_key_from_share`. No new crypto
  dependency of note, and no redpallas verifier needed in the helper.
- **Follow-up (optional):** migrate #401's signing-room authentication (which today signs with the
  FROST share) onto the same device identity, retiring the share overload there too.
- **Honesty:** migration is fail-open and per-vault, so a vault that has not registered its write keys
  stays governance-open until it does; state this until the ~legacy vaults migrate via #406, and do
  not claim write-auth protects every vault the moment it ships.
