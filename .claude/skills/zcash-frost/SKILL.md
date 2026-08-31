---
name: zcash-frost
description: Use when implementing or reviewing FROST as Zcash uses it - the two signing rounds, what the Coordinator is and is not trusted with, what RFC 9591 deliberately leaves to the implementation (transport, authentication, sessions), rerandomized FROST / RedPallas and ZIP 312, DKG, and share repair. Read before touching ceremony, signing, DKG or randomizer code.
---

# FROST, as it actually applies to Zcash

The one thing to internalise: **FROST is a signing protocol, not a system.** RFC 9591 specifies the
maths and the message *contents*, and almost nothing about how those messages travel, who you are
talking to, or how a session begins and ends. That gap is written into the spec, and it is where
implementations get compromised - because implementers assume FROST covers it.

RFC 9591 is IRTF/CFRG, **Informational**, June 2024. It is the specification of the protocol, and it
says of itself: *"is not an IETF product and is not a standard."* Cite it as the spec, not as an IETF
standard.

## Public vs secret

| Value | Kind | Travels? |
|---|---|---|
| Signing key share `sk_i` | **Secret**, per participant | Never. Configured once at key generation. |
| Nonce pair `(hiding, binding)` from round 1 | **Secret**, single-use | Never leaves the participant. |
| Nonce commitments (two Elements) | Public | Round 1 → Coordinator → all participants |
| Message `msg` | Public to the group | Round 2, from the Coordinator |
| Signature share `z_i` (Scalar) | Public | Round 2 → Coordinator |
| Group public key `PK`, per-participant `PK_i` | Public ("group info") | Configured at key generation |
| Final signature `(R, z)` | Public | Output |

A signature share is not a secret, but is only safe *given* its nonce is never reused (§7.3).

## The two rounds, precisely

**Round 1 - commitment** (§5.1). `commit(sk_i)` calls `nonce_generate` twice; each nonce is
`H3(random_bytes(32) || SerializeScalar(sk_i))` - fresh randomness *hedged* with the secret share, not
derived from it. Nonces stay local, commitments go to the Coordinator. The nonces **MUST NOT** be used
in more than one `sign` and **MUST** come from secure randomness.

**Round 2 - signature share** (§5.2). The Coordinator sends the message plus the `commitment_list` for
all chosen participants, sorted ascending by identifier. Before anything else, each participant
**MUST** deserialize every Element with `DeserializeElement` and abort if it fails, and **MUST** check
that its own identifier and its own round-1 commitments appear in that list.

Then `sig_share = hiding_nonce + (binding_nonce * binding_factor) + (lambda_i * sk_i * challenge)`,
with binding factor `H1(PK || H4(msg) || H5(encoded commitment list) || identifier)` and challenge
`H2(R || PK || msg)` - so the share is bound to the message *and* the exact commitment set. After
signing, each participant **MUST** delete the nonce and commitment.

**Aggregation** (§5.3). `z` is the plain sum of shares; the signature is `(R, z)` with `R` the group
commitment. The Coordinator **MUST** validate each share with `DeserializeScalar` and **SHOULD** verify
the aggregate under `PK` before publishing. Subsets of valid shares do **not** yield a valid aggregate.
On failure it **MAY** run `verify_signature_share` per participant - and `PK`/`PK_i` for that check
**MUST** come from stored group info, never from the wire.

Trap the ZF Book flags: **every selected participant must produce a share**, even if more than `t` were
selected. Selecting 3 in a 2-of-3 means all 3 must answer; the Coordinator may start with exactly `t`.

## The Coordinator: what it is and is not trusted with

- **Not trusted with any private information.** §7: *"the Coordinator is not trusted with any private
  information."* It never sees a share or a nonce.
- **Corruptible without breaking unforgeability.** The EUF-CMA claim holds when the Coordinator **and**
  up to `MIN_PARTICIPANTS - 1` participants are corrupted.
- **Trusted for liveness and policing.** FROST's DoS resistance assumes the Coordinator does not itself
  DoS and does identify misbehaving participants so they can be excluded.
- **FROST provides no robustness.** One malformed or withheld share kills the session; the spec's
  answer is to abort. `[ROAST]` is named as a wrapper that adds robustness; FROST does not.
- **It chooses the message.** Which is why §7.7 exists - see below.

Removing the Coordinator (§7.5) does not change the security implications; every participant just talks
to every other. It does open a view-splitting DoS, which the spec says implementations may want to fix
with authenticated messages.

## What the spec deliberately leaves to you

**The most useful section here.** Each row is explicitly out of scope, and each is a place where a real
system gets attacked.

| Left open | What the spec actually says | Consequence |
|---|---|---|
| **Key generation** | Out of scope. Appendix C gives trusted-dealer keygen "for completeness". DKG is not in the RFC at all. | You are picking an unspecified protocol. |
| **Distributing shares and group info** | *"This document does not specify how this information ... is configured and distributed."* | Your provisioning channel is your own design. |
| **Message transport** | Only: delivery must be **reliable**. | Retries, ordering, delivery are yours. |
| **Authentication** | *"in order to identify misbehaving participants, we assume that the network channel is additionally authenticated; confidentiality is not required."* **No mechanism is given.** | If your channel is not authenticated, identifiable abort is worthless - a cheater lies about its identifier. |
| **Who is in the group** | *"FROST assumes that the Coordinator and the set of signer participants are chosen externally to the protocol."* | Admission control is yours. |
| **Sessions / replay** | The RFC has no session identifier and no replay concept. The only hedge it names is that the Coordinator **MAY** track used nonce commitments per group key (§7.3), at the cost of state. | Session binding and replay defence are yours. |
| **Failure handling** | §7.4: nothing beyond "abort". | Recovery, timeouts, retries are yours. |
| **Acting on a cheater** | §5.4: out of scope. It suggests exclusion from future runs as one reasonable approach. | Policy is yours. |
| **Message validation** | §7.7: application-specific, but **RECOMMENDED** so *"participants do not operate as signing oracles for arbitrary messages."* | The signer must understand what it signs. |
| **Metadata protection** | Explicit non-goal; use a higher-level channel if you want it. | Who-signed-with-whom leaks unless you hide it. |

The ZF Book makes the authentication point concrete: identifiers used for cheater detection **must**
come from a mapping between authenticated channels and identifiers - *"you should not simply send the
Identifier along with the SignatureShare; otherwise the cheater could simply lie about their
identifier."* ZF's own answer, in code: `frost-client init` generates a **communication keypair
separate from the FROST share**, uses Noise (`snow`) to end-to-end encrypt, and signs `frostd`'s login
challenge with it (`xeddsa`). `frostd` *"doesn't really care about the particular key pair being used;
it is only used to enforce who can send messages to who."*

## The Zcash specialisation: rerandomized FROST (RedPallas)

**ZIP 312 - "FROST for Spend Authorization Multisignatures". Status: Draft. Category: Wallet. No
target network upgrade.** Draft means draft; do not present it as settled.

Zcash spend authorization signatures are RedDSA, and the protocol **re-randomizes** the spend
authorization key per transaction for unlinkability. Plain FROST always signs under the same key, so it
cannot be used as-is. ZIP 312 specifies **Re-Randomized FROST**:

- **Round 1 is unchanged.**
- In **Round 2** the Coordinator generates a `randomizer` and sends it with the message and
  commitments over a **confidential and authenticated** channel. ZIP 312 flags this explicitly:
  *"this differs from regular FROST which just requires an authenticated channel."*
- The modification is two substitutions: `sk_i = sk_i + randomizer`, and everywhere the group key
  appears, `group_public_key = group_public_key + ScalarBaseMult(randomizer)`. Share verification also
  shifts `PK_i` by the same element. Aggregation shifts the group key.
- Ciphersuites: **FROST(Pallas, BLAKE2b-512)** = RedPallas = Orchard; **FROST(Jubjub, BLAKE2b-512)** =
  RedJubjub = Sapling. `H2` is defined as Zcash's own `H^⊛`, so FROST's challenge matches the one
  `RedDSA.Validate` computes - that is what makes the output verify as a normal spend authorization
  signature. Reference implementation named by the ZIP: the `reddsa` crate.

**Threat model, as the ZIP states it:** the Coordinator *is* trusted with the **privacy** of the
transaction, including unlinkability - a rogue Coordinator breaks privacy but **cannot** produce a
signed transaction without `MIN_PARTICIPANTS` approvals. Share holders are likewise trusted with
privacy. ZIP 312 also does not support the coordinator-less topology, does not stop share holders
linking a signing session to a chain transaction, and puts network privacy out of scope.

**The SIGHASH clause - the origin of on-device message binding.** ZIP 312, Round Two: the message is
the SIGHASH, which *"does not convey enough information for the signers to decide if they want to
authorize the transaction"*. So more data must travel over the same encrypted, authenticated channel,
and **signers MUST check that the given SIGHASH matches that data, or compute the SIGHASH themselves**;
the ZIP puts the mechanism out of scope. That is the primary-source basis for recomputing the sighash
on-device rather than signing what you were handed.

**Library drift worth knowing.** `frost-rerandomized` **deprecated** `sign(randomizer)` in favour of
`sign_with_randomizer_seed`: the Coordinator sends a random *seed* and each participant regenerates the
randomizer via `Randomizer::regenerate_from_seed_and_commitments`, so *"participants don't need to fully
trust the Coordinator's random number generator"*. The binding differs: the current API hashes
`seed || commitments`, while ZIP 312's `randomizer_generate` hashes random bytes with the whole signing
package (commitments **and** message). Check which one your dependency implements.

## Key generation

**Trusted dealer** (RFC Appendix C). The dealer is trusted to generate good randomness, delete secret
values afterwards, and keep them confidential. Shares travel over a mutually authenticated channel
with confidentiality *and* integrity. Participants **MUST** abort if their views of the
`vss_commitment` differ, and **MUST** run `vss_verify` on their own share.

**DKG** - not in RFC 9591. ZF implements the DKG from the original FROST paper, minus the context
string (*"deemed unnecessary after further analysis"*). Three library calls, two network rounds:

1. `dkg::part1` → a secret package (keep) + a round-1 package that **MUST** go out over a real
   **broadcast channel**. Not "send to everyone": the Book defines it as echo broadcast with
   agreement/validity/non-triviality, run as `n` parallel instances. *"Failure in using a proper
   broadcast channel will make the key generation insecure."* Named alternative: an authenticated
   central server as a public bulletin board, trusted to give everyone one view.
2. `dkg::part2` → per-participant round-2 packages, point to point. These **MUST** be encrypted -
   *"an attacker who can read the content of the packages will be able to recreate the secret"* - and
   identifiers must come from the authenticated channel mapping.
3. `dkg::part3` → the participant's `KeyPackage` (its share) and the `PublicKeyPackage` (group
   verifying key). Every participant derives the same `PublicKeyPackage`.

The secret is never assembled anywhere. That is the whole point of preferring DKG over a dealer.

## Repair (RTS) and refresh

**Repair** (`frost_core::keys::repairable`, the Repairable Threshold Scheme from eprint 2017/1155) lets
a threshold of *helpers* restore a lost share, or issue one to a **new** participant at the same
threshold (2-of-3 → 2-of-4). Each helper runs `repair_share_part1` producing `delta` values for every
helper, then `repair_share_part2` over the deltas it received producing a `sigma` for the recovering
participant, who runs `repair_share_part3` over the sigmas plus the `PublicKeyPackage`. **No helper
learns the repaired share.**

**Refresh** rotates shares while keeping the same group verifying key, and can drop a participant. The
Book's caveat is load-bearing: refresh **does not restore full security**. Security then depends on a
threshold of *every past* participant set being honest - a removed member who kept their pre-refresh
share can still collude with a current one. If that is unacceptable, migrate to a new group.

## Security caveats the sources state

- **Nonce reuse is catastrophic** (§7.3). Reuse enables *"a complete key-recovery attack"* through
  replay by other participants. Randomness MUST be uniform. Never precompute a round-1 commitment you
  cannot guarantee is consumed exactly once, and never re-answer a second round 2 with the same nonce.
- **Do not adopt the `[StrongerSec22]` optimization** (§7.2): **NOT RECOMMENDED**, because it removes
  the guarantee that the set that started round 1 is the set that produced the signature.
- **Side channels** (§7.1): `ScalarMult`, `ScalarBaseMult`, `SerializeScalar`, `DeserializeScalar`
  should be constant-time.
- **No pre-hashing** (§7.6). The whole message must be known before signing. If you must pre-hash, use
  a collision-resistant hash with a distinct prefix; the Book advises defining a proper ciphersuite
  rather than passing a hash where a message is expected.
- **Stated non-goals:** post-quantum security, robustness, downgrade prevention, metadata protection.
- **Audit scope, honestly.** NCC audited `frost-core` and five ciphersuites at v0.6.0 - trusted-dealer
  keygen, DKG and signing - and explicitly **not** `frost-secp256k1-tr` and **not rerandomized FROST**,
  the variant Zcash uses. `frostd` and `frost-client` carry a separate Least Authority audit per their
  READMEs. Never describe the Zcash path as covered by the NCC audit.

## Sources

Primary only - no blog posts, summaries or social media. Unsourced claims were left out, not guessed.

- **RFC 9591** (rfc-editor.org) - protocol, security considerations, trusted-dealer appendix. All `§`
  references above are its.
- **ZF FROST Book** (frost.zfnd.org) - Understanding FROST, Tutorial, DKG, Terminology
  (broadcast/peer-to-peer channels), Network Topologies, `frostd`.
- **`ZcashFoundation/frost`** - README (RTS, DKG provenance, NCC scope),
  `frost-rerandomized/src/lib.rs`, `frost-core/src/keys/repairable.rs`.
- **`ZcashFoundation/frost-tools`** - README, `frostd` + `frost-client` READMEs,
  `frost-client/src/cli/init.rs`, `src/cipher.rs`.
- **ZIP 312** (zips.z.cash/zip-0312) - Re-Randomized FROST, ciphersuites, threat model, SIGHASH clause.

---

**Verified against these sources on 2026-08-31.** Re-check before relying on any statement here -
ZIP 312 is Draft and can change, and `frost-rerandomized`'s randomizer API is already mid-migration.
