# ADR-0012: The FROST share signs one seat certificate, verified by the coordinator (amends ADR-0011)

- **Status:** accepted (live in v0.18.0, coordinator since 2026-11-08 00:06 UTC)
- **Date:** 2026-11-07 (first draft 2026-10-15); published 2026-11-08 with [GHSA-42h7-6fcj-554w](https://github.com/deegalabs/konclave/security/advisories/GHSA-42h7-6fcj-554w)
- **Amends:** ADR-0011 (D1, D3, the rejected alternative A1, and two Consequences; see the last section)

## Context

**What ADR-0011 decided.** Governance writes are authenticated by a per-device Ed25519 key derived
from the share, not by the share itself (A2), for key hygiene, following the Foundation's
`frost-client`. It recorded that the share is reserved for the threshold signature, rejected signing
with the share (A1) because it "overloads the signing key", and noted that the helper would need no
RedPallas verifier.

**What ADR-0011 left open, by its own amendment.** A device's write key is bound to a seat when the
device registers, and that registration carried no proof of the share: the route was gated by the
vault's read key only. The 2026-10-06 amendment says so: a seat nobody has registered is still
first-come (#577). The read key had the same shape one step earlier: a vault with no read key was open,
and its first read key was set through a route gated by the same check. Before a vault's read key and
seats were bound, the coordinator held nothing that told a member's registration from anyone else's.

**What changed since ADR-0011.**
1. The share already signed messages other than the threshold signature: the signing room's `rejoin`,
   `armed` and `unarmed`, and creation's `vsec`, `created` and `done`, under the room domain. "The share
   signs threshold transactions and nothing else" did not describe the code.
2. The only material tied to a vault id before the vault is registered is the members' shares. The id
   is the group key, which exists only after the key generation.
3. One seat's proof is not enough. A package consistent with the vault id can be built by someone
   holding fewer than `t` shares. `t` distinct seats proving over one package can only come from `t`
   real shares.

So the question is what the coordinator can check about a new vault before any device key is bound.
The answer: signatures by the shares, from `t` distinct seats, over one package.

## Decision

For vaults created under creation protocol 3, **each seat's FROST share signs exactly one
certificate**, the coordinator verifies the certificates, and once `t` distinct seats agree it **pins**
the vault's package, read-key hash and seat bindings. Every governance write after that stays
ADR-0011 A2.

- **D1, the certificate.** One RedPallas SpendAuth signature (reddsa 0.5.2) by the seat's signing share
  over a canonical, length-prefixed message that binds a closed domain separator, the vault id (the
  group key), the creation protocol, `t`, `n`, the seat, the digest of the public key package, the
  read-key hash, the device's comms key and the device's write key. Roster names are not in it.
  (`konclave-seal::share_sig`.)
- **D2, domain separation.** The domains are a closed list; the room domain keeps its bytes, the
  certificate has its own, and none is a prefix of another. The message is never 32 bytes long (a
  sighash's length), has no free field outside a length prefix, is signed with the base share (never
  under the group key, never with a randomizer), and is built in Rust from typed fields, never from
  bytes handed in by JavaScript or the coordinator.
- **D3, one definition.** The message, the package digest, the read-key hash and sign/verify live once,
  in `konclave-seal`, which the device (`konclave-wasm`) and the coordinator (`orchestrator`) both link.
  `helper-server` maps HTTP only. The room primitive moved into the same module, byte for byte.
- **D4, transport and keeping.** The certificates ride in the protocol-3 `done` message, sealed under a
  key derived from the vault secret `S`. Each device checks the other seats' certificates against its
  own package before it registers anything, and records the full bundle (package and certificates) in
  its own vault record before any network call (`pinBundle`), so a registration the coordinator could
  not take at the end of creation can be finished later from the vault card.
- **D5, the pin; every member posts.** A vault registered under protocol 3 is **closed** (no read key,
  no device keys, no viewing key) until a registration carries certificates from `t` distinct seats
  that verify against one package whose group key equals the vault id and that carry one read-key hash
  (`seat_registry::tally`). Then the coordinator pins the package digest, the read-key hash and each
  proven seat's (seat, comms, write) record, in that order of writes. **Every member whose device holds
  the creation's bundle posts it**: the first post that counts pins; a later post that counts to the
  same package and key confirms and writes nothing; anything else on a pinned vault is refused. A
  device without the bundle (a restored one) never posts: it reads the vault's state and finishes only
  on a vault pinned to its own package digest. A vault a failure left closed is pinned by a later post
  that counts, under the same rule. A seat counts once; a proven seat that proved another read key holds
  its seat and its reads stay refused; the roster is exactly `n` seats, `1..=n`; a pinned package
  cannot be replaced. *(The 2026-10-15 draft said only the creator registers and a joiner's
  registration is refused. That was changed on 2026-10-31: with every member able to
  pin, the creator going offline at the end of creation no longer leaves the vault closed.)*
- **D6, what a certificate proves about keys (comms binding).** A certificate proves a seat, not who
  holds the comms key named in it, and an X25519 key cannot be proven without a challenge. So a proven
  seat is recorded by (seat, comms); a comms or write key named by two seats is accepted, and counts
  once as a recipient; a verified proof with an unusable key does not count and refuses nothing;
  `bundle_invalid` is kept for more proofs than seats and for one seat signing two statements. Claims
  without a proof keep the refusal by comms key. A protocol-3 vault never sends a signing request
  unsealed; it is sealed to the distinct comms keys of the records that carry a seat and a write key,
  and a send with fewer distinct keys than `t` is refused. Nothing computes or reports that a seat is
  sealed to its owner, because no one can know it. One writer of the device registry
  (`write_device_records`) serves both kinds of claim.
- **D7, devices after the pin.** A seat on a pinned vault takes a device only with that seat's own
  certificate over the pinned package and key (`seat_registry::offer_device`): each device presents its
  certificate on unlock. A refusal that carries the coordinator's code is shown and keeps the device's
  signer from arming; one without a code is shown too, and a device left armed has no box to open.
- **D8, writes stay A2.** The certificate is the single place the share vouches for a device. Votes,
  renames, proposals and sends keep the Ed25519 write key under `authorize_write`. The share signs
  nothing new beyond the certificate.
- **D9, new vaults only, and no new open doors.** Vaults that exist keep today's rules. With the deploy
  that turns this on, the coordinator requires creation protocol 3 of every new registration
  (`MIN_CREATION` 3) and refuses every first-set of a read key, on every vault.
- **D10, loud failure.** A refused registration, pin or key reaches the member as a screen with the
  coordinator's reason ("do not use this vault" where it applies), never only the console.

## Related, shipped in the same release (not decided here)

- **3a, the address is the vault's.** On a protocol-3 vault the device derives the receivers from the
  viewing key and checks that its spend authority is the group key, and the members compare the
  viewing key's code before the address is shown. This is a device check; the certificate does not
  cover it (see "what this does not guarantee").
- **Roster (option A).** No roster digest and no change to the signed bytes. The device's own roster is
  the one a restored backup carries; a served roster that differs is said on screen, not silently
  replaced. The coordinator's list can still be wrong (Known limits).
- **Seat caps.** The app and the local bridge offer at most `N_MAX` = 16 seats, the bound a certificate
  bundle carries. The coordinator's own bound stays 32 (#821) so a vault an older app made keeps its
  devices; a test pins app == `N_MAX` <= coordinator.

## Later step, recorded here: 4b, the quorum checked by certificate

Payment content binding (#567) is split in two. **4a**, independent of this ADR and not shipped yet
(#567 is open): before signing, a device recomputes the content hash and verifies its **own** seat's
vote envelope with its **own** write key, and refuses otherwise. **4b**, after this ADR is live in production: a device also verifies the
**other** seats' envelopes, each against a seat certificate that verifies on the device's **own**
public key package. The certificate authenticates itself, so the coordinator can deliver it without
being trusted for it. 4b needs the certificates stored and served (a gated route and a local cache,
checked on the device), which is not in this release; nothing consumes it before 4b. Until 4a and 4b
ship, the "2 of 3" a device shows for other seats' votes is the coordinator's word. 4b fails if the device's own
package came from a defective creation or a tampered backup. It applies to protocol-3 vaults; an older
vault gets 4b only with a certificate it never had.

## Alternatives considered

- **A reservation key created before the key generation.** Rejected: not tied to the vault id, which
  does not exist until the key generation ends; it would add a long-lived secret to store, export and
  restore (the trap of #447 and #480).
- **A single proof by one seat, package supplied by the prover.** Rejected: a package that fits the
  vault id can be built without the quorum.
- **Only the creator registers (the 2026-10-15 form of D5).** Replaced by every member posting: the
  coordinator's count is what protects the pin, so who posts adds nothing, and a single poster made the
  creator's device a liveness point.
- **Ordering (the creator registers before revealing its own round 1).** The fallback had this been
  declined; closes the first read key against the relay and an invite holder but leaves the seat claim
  open and trusts the creator for the read key.
- **Keep ADR-0011 unchanged.** Not possible: nothing the coordinator held tied a device key to a seat
  before the first registration.
- **Heal the vaults that exist.** Out of scope. The recount of 2026-10-27 read five of the six active
  vaults (the sixth belongs to a user outside the project and was not opened): all five with a read
  key and a device registry, none with a creation protocol.

## Consequences

- **What the coordinator verifies, new.** RedPallas signatures against a package's verifying shares;
  the package's group key equals the vault id; `t` distinct seats; one read-key hash; a roster of
  exactly `n`. Before, it verified Ed25519 write signatures only.
- **The dependency.** `reddsa` 0.5.2 becomes a dependency of `konclave-seal`, and through it of the
  coordinator. This reverses ADR-0011's "no RedPallas verifier needed in the helper".
- **Key hygiene.** The share signs threshold transactions, the room messages, and one certificate per
  seat. Single-party RedDSA signing with a key that also signs in FROST is not covered by the FROST
  security proof; accepted as a deviation, with the separations of D2 and fresh hedged nonces.
- **What stays trusted, unchanged.** The coordinator is share-blind and cannot move funds on its own.
  It still builds the transactions the quorum signs (#567) and holds each vault's viewing key (#516).
- **What this does NOT guarantee.**
  - **Insiders.** `t` members together can pin what they choose; fewer than `t` cannot.
  - **Who holds a comms key.** A seat may name a comms key that is not its device's; the boxes to that
    key open only for its holder (D6).
  - **Vaults that exist.** They keep today's rules, except that a read key can no longer be set for the
    first time (D9).
  - **Metadata.** `/api/vault` stays readable by whoever has the id. The relay still sees envelope
    metadata and can still stop a ceremony.
  - **The viewing key's other parts.** A coordinator can serve a viewing key with the right spend
    authority and different `nk`/`rivk`; the code comparison of 3a is what members have against it.
  - **Other seats' votes**, until 4b (above).
- **Liveness.** A new vault is closed until it is pinned. If the coordinator is unreachable at the end
  of creation, the bundle waits in each member's record and any of them can finish it later.

## Migration

- `CREATION_PROTOCOL` 3 on the device; the ceremony version and the relay room follow it, so a protocol-2
  device and a protocol-3 device never share a creation room.
- `MIN_CREATION` 3 on the coordinator **in the same deploy** that turns on the pin (D9). Before that
  deploy a protocol-3 build must not run on a shared service, since it refuses first read keys that an
  older creation still needs.
- Order: **the coordinator first, then web and desktop** (one `ui/` bundle); creation pauses in
  between. Decided by Daniel on 2026-11-07 after an internal security audit of the release path: with the web
  first, the fix would be public while the coordinator still accepted a first read key from anyone
  holding a vault id, and cached older apps would keep creating vaults the pin cannot protect. With
  the coordinator first, an app from 0.13.0 on refuses to start a creation when `client.creation`
  announces 3, and an older one is refused at registration (`update_required`). A protocol-3 device
  reads `client.creation` from `/api/health` and starts only on a coordinator that announces 3, never
  falling back silently. An outdated joiner sees an empty room.
- Nothing changes on disk for the vaults that exist. Rollback: below the coordinator that pins, a pinned
  vault's key file reads as unreadable and fails closed; census `cp >= 3` on the volume before any
  deploy and any rollback.

## Amendment to ADR-0011 (added to that file, dated 2026-11-08)

Recorded, not rewritten, as the 2026-10-06 amendment did. For vaults created under protocol 3:
- **D1** (the share reserved for the threshold signature): the share also signs the room messages and
  one seat certificate per seat.
- **D3** (bind the first roster claim to a signed device key): a device key cannot close it alone; for
  new vaults the seat certificate closes it; for vaults that exist the race stays open.
- **A1** stays rejected for governance writes; ADR-0012 adopts a narrower form for binding a device to a
  seat.
- **Consequences** ("signs threshold transactions and nothing else"; "no RedPallas verifier needed in
  the helper"): superseded as above.
- **Follow-up** (move room authentication off the share): not done; room authentication stays on the
  share and its code moved into `konclave-seal`.
- One line, from the comms-binding decision: a certificate proves a seat, not who holds the comms key
  in it.
