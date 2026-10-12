# Recovery and backup

> What can be lost, what restores it, and the exact procedures. Written after a live audit
> (2026-08-29) that proved the client export alone is not a complete backup.
>
> Update (2026-09-06): on a Private vault the export now carries the viewing key and the scan height
> (#447, #480); the gap remains for Open vaults and for moving a vault to another coordinator.

## Where each secret lives (the trust boundary)

| Layer | Holds | On disk? | Can spend? |
|---|---|---|---|
| **Device** (browser) | the member's **FROST share**, sealed in IndexedDB (AES-GCM under a passphrase) | yes, ciphertext only | yes (a threshold of them) |
| **Helper volume** (`/data/vaults/<id>/`) | **view-only** material: `registration.json` (address + **UFVK** + account + quorum), `wallet/` sync cache, `ceremonies.jsonl`, `proposals/`, `send-attempts/` (one record per real send attempt, plus `.expired-` trails: txid, expiry, no secret), `members.json`, `device-keys.json` | yes | **no** (never a share) |
| **Relay** | room messages it does not parse (public or sealed; a signing request goes unsealed until every seat has registered its device key, #63) | **no** (in-memory, 1h TTL) | no |

Two consequences follow from this table and drive everything below:

1. **Deleting a helper vault dir does not destroy what a rebuild needs if an ops backup of it
   exists (D), or if a member holds a backup made on a Private vault after #480 shipped
   (2026-09-06) while the coordinator was reachable**, which carries the viewing key and the scan height; with neither, the funds are
   lost (see "Why the share alone is not enough" below). Rebuilding from a member's backup alone has
   no tool yet (see "Open work"). The spend power is the share, which lives on devices; the helper
   never holds one (ADR-0006).
2. **A share alone cannot re-derive the vault's on-chain identity.** The address + UFVK are generated
   once, with randomness, at registration and stored only in `registration.json`.

## The complete recovery kit

Recovering a vault so a member can **sign again against the same on-chain address** needs the
member's **share export** — and, since #447 and #480, that export carries what it used to be missing:

| what a rebuild needs | where it comes from |
|---|---|
| the member's sealed share | the export |
| the vault's **address** and **UFVK** | the export (#447 — before that, only `registration.json`) |
| the **scan floor** (`birthday`) | the export (#480 — before that, nowhere the member had) |
| the quorum (`t`/`n`) | decoded from the share bundle itself |
| the change receiver | derivable from the UFVK |

The address travels in every v2 export; the viewing key and the scan floor only on a **Private**
vault. An Open vault cannot fetch its viewing key (the helper refuses it to a vault with no read
key), so its export restores the seat and not the vault.

**What is still only on the helper**, and is correctly not in the export: `wallet_dir` (a path on the
helper's machine) and `account` (a uuid the helper's wallet database minted — a rebuild runs
`init-fvk` and gets a new one).

> **Why the scan floor is not optional.** A wallet rebuilt with the right viewing key but no
> birthday starts scanning at the CURRENT height and never sees a single note the vault already
> holds. There is no rescan. It does not look like a failure — it looks like an empty vault, and the
> UI tells the treasurer to add funds. That is #434, and until #480 the export did not carry the
> number even though the helper had it all along.

### Why the share alone is not enough (verified live)

The helper derives a vault's address + UFVK with `zcash-sign generate --ak <group_key>`
(`helper::derive_identity`), and that call is **non-deterministic**. Two runs with the same
`--ak` produce two different addresses/UFVKs. So re-registering a vault (even with the correct group
key and share) mints a **new** address. On-chain notes at the old address need the old UFVK (its
`nk`) to be detected and spent, so they are unrecoverable without the old `registration.json`, even
with a threshold of shares.

## Procedures

### A. Member lost their device (share recovery)

Precondition: the member kept their **share export** (file + passphrase), and the vault still exists
on the helper.

1. On the new device, open the app and **import** the export bundle, entering the passphrase.
2. The share is re-sealed in the new device's IndexedDB; the member resumes their seat and can
   approve/sign again.

Note: each member backs up **their own** share. Concentrating every member's export in one place
restores full control but defeats the single-person-proof property, so do not do it for a real
multi-party vault.

### B. Helper volume lost or a vault dir deleted (identity recovery)

Precondition: an out-of-band backup of the vault's `registration.json` (see D).

1. Restore the vault dir (at least `registration.json`) to `/data/vaults/<id>/` on the volume.
2. Redeploy the helper so it reloads the registry from disk.
3. **Rebuild `wallet/` by hand, passing the recorded birthday.** This step used to read *"the helper
   re-syncs `wallet/` from chain"*. **It does not, and never did** (#434): `register_vault` returns
   as soon as it finds a `registration.json`, before any wallet init, and never checks that the
   wallet directory is still there. A restore that stops at step 2 leaves a vault whose reads fail.
   ```
   zcash-devtool wallet -w /data/vaults/<id>/wallet init-fvk \
     --name <id> --fvk <ufvk from registration.json> \
     --birthday <birthday from registration.json> \
     -s zec.rocks:443 --connection direct
   ```
   **The `--birthday` is not optional.** Without it `init-fvk` starts scanning from roughly the
   current height, and every note the vault already holds becomes invisible: the balance reads 0,
   the history reads empty, and there is no rescan command to undo it (`wallet reset` needs a seed,
   and these wallets are `init_without_mnemonic`). The number is in `registration.json` for vaults
   registered since #434, and in the old `wallet/keys.toml` if you still have it. **If you have
   neither, stop and ask before running `init-fvk`** - a wrong birthday is not recoverable in place.
4. Members recover their shares per procedure A if needed.

Without step 1, re-registration would produce a different address and orphan any funds.

### C. Reversible retirement of a vault (cleanup without deleting)

Used on 2026-08-29 to retire 21 disposable test vaults without destroying them.

- **Retire:** `mv /data/vaults/<id> /data/vaults/_retired/<id>` on the volume, then redeploy. The
  boot scan only reads top-level `<id>/registration.json`, so a retired vault becomes invisible to
  the helper but stays fully recoverable on the volume.
- **Restore:** `mv /data/vaults/_retired/<id> /data/vaults/<id>`, then redeploy. Identity comes back
  identical because `registration.json` moved with it.

### D. Ops backup of vault identities (the out-of-band half)

Pull a local copy of every vault's view-only metadata. Two files per vault are the identity, and both
are needed (the command below also takes `device-keys.json`, `read-key.json`, `members.json` and the
proposals, which procedures F, G and H restore from):

- **`registration.json`** - the irreplaceable part: the UFVK and the address, minted once with
  randomness and reproducible nowhere.
- **`wallet/keys.toml`** - two lines, one of which is the **birthday**. The rest of `wallet/` is a
  rebuildable cache and is excluded; this file is not, because rebuilding needs the number in it
  (procedure B) and there is no rescan if you get it wrong.

Since #444/#445 the helper also copies the birthday into `registration.json` on boot, so a vault
touched by a deploy after that carries it in both places. **Take `keys.toml` anyway**: the copy in
`registration.json` only exists for vaults the running helper has seen since that deploy, and a
backup should not depend on knowing which those are.

```
railway ssh 'cd /data/vaults && tar czf - --exclude=*/wallet/[!k]* . | base64 -w0' \
  | grep -E '^[A-Za-z0-9+/=]+$' | base64 -d | tar xzf - -C <local-backup-dir>
```

**Verified 2026-09-06** by taking exactly this backup of the live volume: 8 vaults, every one with
its UFVK, address, quorum, network and birthday. Worth recording what the run showed, because the
table is the point of the exercise: the birthdays range from 3,453,936 to 3,467,365, so a rebuild
that guessed "recent" would have buried months of history on the older vaults - and one vault
(`13136015…`) is on **testnet**, with a birthday from a different chain entirely.

Store the result off the server. With this plus each member's share export, any vault is fully
recoverable.

### E. A payment is held as "not settled"

The coordinator keeps a record of every real send under `<vault>/send-attempts/<proposal>.json`
BEFORE the transaction is broadcast. While a proposal has one that is not settled, a new Send for it
is refused with "an earlier attempt to send this payment is not settled". The record of a send that
finished stays on disk for good, so a listing of that directory is not the list of held payments: the
boot log has that (`send records: held, vault <prefix> proposal <id>`, the first 20, with a record
the coordinator cannot read marked `UNREADABLE record`), and a record is held only while its proposal
is not `sent`. There is one record per real send attempt, including one whose broadcast errored.

The chain settles it, on its own:

- **Mined:** the proposal becomes `sent` with its txid, the next time someone presses Send for it, or
  the vault's proposals or ledger are read once the coordinator's wallet has synced past the
  transaction (a balance read, or a Send, syncs it; a read of the proposals does not). This matters
  because a held proposal can pass its own 72-hour deadline and read `expired`, and then nobody
  presses Send. A read looks at the wallet at most every 15 seconds per vault (the time of the last
  look is the file `<vault>/last_promote`), whatever it finds, and for as long as any payment is held.
- **Can no longer be mined** (its own `expiry_height` plus 10 blocks has passed, not mined): the
  record is moved aside as `<proposal>.expired-<unix>.json`, and the next Send for a proposal that is
  still `ready` goes on. A proposal that has meanwhile expired or been refused does not.

Do not create a replacement payment while one is held: the held transaction may still be mined, and
both would be paid.

What an operator can check without writing anything (read-only, as the volume rule requires):

1. `cat` the record. It holds the `txid` (and `reported_txid`, if the broadcast tool printed another)
   and the `expiry_height` the signed transaction carries. `0` means it never expires and is never
   cleared on its own.
2. Look the `txid` up in a block explorer. Mined: the payment is made. Not found: it may be in a
   mempool, or never have reached one.
3. Compare `expiry_height` with the chain tip. Past it by more than 10 and not mined: the next Send
   clears the record by itself.

These holds have no way out of their own and need a founder at the desk: a record with `expiry_height`
`0`; a coordinator whose wallet cannot be synced or read (the refusal is logged under the vault's
8-character prefix); a record that cannot be read (a half file, a bad txid); and a payment held past
its own deadline that is never mined. Moving or deleting a record is a decision for the founders, taken
after steps 1 to 3 show the transaction is not on the chain and cannot be mined; it is not a routine
procedure, because it is the one step that can allow a second payment.

A volume that cannot hard-link or sync a directory cannot hold records: the boot log says so
(`send records: ALERT this volume could not be shown able to hold them`) and every real send is refused before any device
is asked to sign.

Restoring an ops backup (D) taken before an attempt, or rolling the coordinator back to a build
without records, ignores or loses the record: the protection is gone for any proposal that had one.
Do not roll back, or restore over a vault, while a payment is held.

**Before any roll-back.** The build before this one ignores `send-attempts/`: for a proposal that is
`ready` and has a record, a Send on it builds and broadcasts a SECOND payment with the same approved
lines (a single-note vault is held by its wallet for the first payment's lifetime, which is a brake and
not a guarantee). So:

- Do not roll back if the boot log printed `send records: N held payment(s)` with N above zero, or if
  any `send-attempts/*.json` (not `.expired-`) belongs to a proposal that is not yet `sent`. Check each
  by hand first: a `ready` one is a money risk (a second payment), an `expired` or `refused` one is a
  ledger risk (a payment that was mined stays out of the ledger until the coordinator is rolled
  forward again).
- If a roll-back cannot be avoided with a payment held, start the older build WITHOUT
  `KONCLAVE_RELAY_BASES`: it then refuses every send (503) until the founders have resolved each held
  payment by hand, in the explorer.
- A roll-back also puts back what the older build did not have: its registration and read rules, and
  the unsealed signing request for a send nobody signed. Say so to the members.
- The other direction has the same hole: a send that was in flight on the older build when the
  container was replaced may have been broadcast with no record, and the new build would then offer a
  second payment for a proposal that still reads `ready`. Check the HTTP log for a send in flight
  before deploying, and before the first Send on the new build confirm, for each `ready` proposal,
  that no send was ever started on the older one: from the wallet's transaction list and the
  explorer, not only from the HTTP log, which may have rotated.

### F. A seat's registration is not its member's device

The coordinator keeps, for each seat, the device that holds it: the device's comms key, the seat, and
the Ed25519 key it signs governance writes with (`device-keys.json`, one record per device). Once a
record holds a seat and a key it does not change by itself, so a record that is WRONG stays wrong
until an operator replaces it. (Before this rule a member's device put it right the next time it
unlocked; that is the one thing that no longer happens.)

1. The member tells the group, out of band, that their seat does not sign.
2. The member reads their own three values from THEIR device: the comms key, the seat, the write key. The
   device computes them from its share, and **there is no tool for it yet**: no screen shows them and
   there is no script. Until one exists this step cannot be done by a member alone, and the founders
   should not go on to step 4 on the strength of a record that merely looks odd. (A script that derives
   the three values from a member's export is the follow-up this procedure is waiting for.)
3. The founders compare them with the record, read-only (`cat` the file; the record is the one for
   that seat). Only if they differ and the member is who they say, go on.
4. **Replace the record, do not remove it.** Removing it leaves the seat unregistered until the
   member next unlocks, and in that gap anyone with the read key can register the seat first and
   freeze the wrong key again. Build the replacement ON YOUR OWN MACHINE from a copy of the file (the
   coordinator's image has no `jq`), with the one record changed, and check it there. `jq . new` is NOT a
   check: it passes an empty file, `[]`, `{}` and `null`, and `[]` or a record with no seat or write key
   OPENS the vault to unsigned writes. Use `jq -e 'type == "array" and length > 0 and all(.[]; (.comms |
   type == "string") and (.seat | type == "number") and (.write | type == "string"))' new` (when every
   record holds a seat) and `diff <(jq -S . old) <(jq -S . new)`, which must show only that record. Put it
   on the volume under a temporary name in the same directory, give it the owner and mode the
   coordinator reads (`chown konclave:konclave`, `chmod 644`), and `mv -T` it over the old one in a single
   step (`-T` refuses a directory). A file that does not parse freezes the whole vault (procedure G),
   so the check is not optional.
5. Read the file again (`cat`) and confirm it is the replacement. Do the `mv` when no member is
   unlocking: the coordinator replaces this file when a device registers, and a registration that
   races the `mv` can put the old record back. Tell the members first. Never remove `read-key.json` or
   `device-keys.json` to replace it (see H): replace it with `mv -T`, so there is no instant without it.
6. The member unlocks once more: the same registration now matches and changes nothing.

This is a deliberate act of the founders, at the desk, on a volume sessions treat as read-only; it is
not a routine procedure.

### G. The device registry is unreadable

`device-keys.json` that exists and does not read (zero bytes, half a document, garbage, a directory, a
permission the coordinator lacks) makes the coordinator refuse governance writes for that vault, the
viewing key and sealed sends (503, "this vault's device list cannot be read ..."), and the boot log
says so (`device registries: UNREADABLE, vault <prefix>`). It does not read the file as "no devices",
and no registration rewrites it. Reading the vault keeps working. What stops until it is restored:
votes, proposals, renames and sends (503), the viewing key (so a member's backup export, which asks
for it, leaves without one: take it again afterwards), and the sealing of a signing request.

Two ways out, a decision for the founders:

- **Restore the file from the ops backup (D)**, which includes `device-keys.json`. Check it first, on
  your own machine, with the `jq -e` and the `diff` of F step 4 (a bare "it parses" passes `[]`, which
  opens the vault). This keeps every seat's registration.
- **Set the file aside.** The vault then has no registry: it is open to unsigned governance writes
  again (ADR-0011 D5) until the members unlock and register, and until then anyone with the read key
  can register a seat first. Do this only when no backup exists, and say so to the members.

Setting the file aside has two more effects: an UNSIGNED send from a vault whose devices are not all
registered answers 409 ("this vault still has members whose devices are not registered ...") until they
register (a send a seat signs still goes through),
and the viewing key is served in clear text again (to a holder of the read key) until a device registers.

Take the same care as in F: build and check the replacement on your own machine, put it on the volume
under a temporary name, `chown` and `chmod`, then `mv -T`.

### H. A vault's read key file is unreadable

`read-key.json` that exists and is not a key (zero bytes, half a document, `null`, an empty or blank
string, a directory, a permission the coordinator lacks) makes the coordinator refuse every private
read of that vault (balance, transactions, ceremonies, proposals, ledger, members and the viewing key),
with or without a token, and the boot log says so (`read keys: UNREADABLE, vault <prefix>`). The vault's
public metadata (`GET /api/vault`) stays open by design. The file is not read as "no key", which would
open the reads, the registration of a device and the replacement of the key to anyone holding only
the vault id. The members see an EMPTY vault, not an error: no balance and no proposals.

- **Restore the file from the ops backup (D)**, which includes it. Check it first, on your own
  machine: `test "$(head -c1 read-key.json)" = '"' && jq -e -s 'length == 1 and (.[0] | type == "string"
  and test("^[^\\s]+$"))' read-key.json`. A plain `jq .` passes an empty string, `null` and a blank
  one, and a bare `jq -e` passes a file with a byte-order mark, two strings, or `null` followed by a
  string, which the coordinator refuses. Put it in place with `mv -T`, as in F.
- **Without a backup there is no clean way out.** Do not just remove the file: the vault then reads as
  unprotected, and the route that sets a key asks for no credential while none is set, so whoever knows
  the vault id can set the key first, read the vault, and lock the members out (nothing in the
  app sets the key again after the vault is created). A random 64-hex value in the file keeps the
  vault closed, but no member's device holds it, so the members still cannot read until a way to set
  their own key exists, and there is no tool for that yet. Decide with the members, and tell them.

## Opening an export without Konclave

The encrypted export is the only spare key a member has, so it must be openable when Konclave is
not there to open it — a dead laptop, a browser that will not start, or the project itself gone.
It is deliberately plain cryptography with no custom format, so a standard library is enough.

The file has five fields outside the ciphertext, and none of them is a secret:

| field | what it is |
|---|---|
| `format`, `version` | how to read the file |
| `kdfIters`, `salt`, `iv` | **public parameters** of the KDF and the cipher — they must travel with the ciphertext or nothing opens |
| `exportedAt` | when it was written |
| `cipher` | everything else |

Inside `cipher`, under AES-256-GCM with a key derived from the passphrase by **PBKDF2-HMAC-SHA256**:
the vault id, name, governance, your member name, the creator, the group key, the address, the
roster, the creation date, **your share**, the vault's access secret `S`, the beneficiaries, the
**viewing key**, the scan floor (`birthday`, #480) and the pinned change receiver (#281). The
viewing key and the scan floor are present only when the export was made on a Private vault.
Nothing identifies the vault from outside the ciphertext, not even its id.

```sh
node scripts/open-export.mjs export.json
```

It asks for the passphrase on the terminal (so it never lands in shell history), and reports the
fields a rebuild needs rather than dumping the payload — because the question after taking a backup
is not "does it decrypt" but **"is everything I need in there"**:

```
  Konclave export · v2 · sealed 2026-09-06 · PBKDF2 600000

  Vault      Collective Zcash 2.0
  You        Daniel
  Members    Zka, Daniel, Bob
  Address    u1w5cr43t0nye74cfudyv06dm845nq0v0pr3mu9yxqrmuh4zvr56nzuad46h

  What a rebuild needs
    your share                    yes
    the vault's address           yes
    the viewing key (#447)        yes
    the scan floor (#480)         yes   (block 3459814)
```

A backup missing either of the last two says so, and says what it costs. `--show-secrets` prints the
share and the keys themselves; without it they stay out of the terminal buffer, because checking a
backup is the common reason to run this and printing a share for that is a bad trade.

Exit codes are usable from a script: `0` it opened, `1` it did not, `2` you called it wrong.

**The script depends on nothing.** Node's own `crypto`, no packages, no network — if Node runs, the
file opens. That is the point: it has to work on a machine that has never had Konclave on it. The
whole derivation is PBKDF2-HMAC-SHA256 to an AES-256-GCM key, so any language with those two
primitives can do the same in about fifteen lines.

**A wrong passphrase throws.** AES-GCM authenticates, so it does not decrypt to garbage — it
refuses. The same is true of a file that has been altered by a byte.

**What this gets you.** The payload contains the share, the address, the viewing key and the scan
floor — everything a rebuild needs (see *The complete recovery kit* above). What it does not contain
is the helper's `wallet_dir` and `account`, and neither is portable: one is a path on another
machine, the other a database id a rebuild re-mints.

> **A v1 export** (no `version` field, or `version: 1`) is a different shape: the metadata is in the
> clear and only the share is sealed. The same derivation opens it; the fields differ. #405 replaced
> it precisely so a leaked backup would reveal nothing, including which vault it belongs to. Konclave
> checks a v1 file before importing it, and `scripts/open-export.mjs` reports what it would refuse.

## Open work

- **#214**: the export now carries the viewing key, the address and the scan height. Still
  missing: a restore/adopt path in the coordinator that accepts an existing viewing key instead of
  deriving a new one. Until it exists, procedure D remains the only way to rebuild a vault on a new
  coordinator.
- **#308** tracks the recovery-claim honesty pass (member-recovery / inheritance are not shipped).
- **#388** (done 2026-08-30): a leaked vault id no longer opens the reads on a Private vault; Open
  vaults stay readable until re-created (#406).
