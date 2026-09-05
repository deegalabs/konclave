# Recovery and backup

> What can be lost, what restores it, and the exact procedures. Written after a live audit
> (2026-08-29) that proved the client export alone is not a complete backup.

## Where each secret lives (the trust boundary)

| Layer | Holds | On disk? | Can spend? |
|---|---|---|---|
| **Device** (browser) | the member's **FROST share**, sealed in IndexedDB (AES-GCM under a passphrase) | yes, ciphertext only | yes (a threshold of them) |
| **Helper volume** (`/data/vaults/<id>/`) | **view-only** material: `registration.json` (address + **UFVK** + account + quorum), `wallet/` sync cache, `ceremonies.jsonl`, `proposals/`, `members.json`, `device-keys.json` | yes | **no** (never a share) |
| **Relay** | opaque room messages | **no** (in-memory, 1h TTL) | no |

Two consequences follow from this table and drive everything below:

1. **Deleting a helper vault dir cannot lose funds.** The spend power is the share, which lives on
   devices. The helper is view-only by design (ADR-0006).
2. **A share alone cannot re-derive the vault's on-chain identity.** The address + UFVK are generated
   once, with randomness, at registration and stored only in `registration.json`.

## The complete recovery kit

Recovering a vault so a member can **sign again against the same on-chain address** needs BOTH halves:

- **Share export** (device half): the member's sealed share + public record, passphrase-encrypted.
- **`registration.json`** (helper half): the vault's exact **UFVK + address**.

The share export by itself restores the signing seat but **not** the vault identity. See #214.

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
3. The helper re-syncs `wallet/` from chain (the on-chain history and balance rebuild from the UFVK).
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

Pull a local copy of every vault's view-only metadata (the `registration.json` UFVK is the
irreplaceable part; the `wallet/` cache is rebuildable and skipped):

```
railway ssh 'cd /data/vaults && tar czf - --exclude=*/wallet . | base64 -w0' \
  | grep -E '^[A-Za-z0-9+/=]+$' | base64 -d | tar xzf - -C <local-backup-dir>
```

Store the result off the server. With this plus each member's share export, any vault is fully
recoverable.

## Open work

- **#214** wants the fix: the export should also carry the UFVK + address, and the helper should gain
  a **restore/adopt** path that accepts a client-provided UFVK instead of re-deriving. Until then,
  procedure D is mandatory for any funded vault.
- **#308** tracks the recovery-claim honesty pass (member-recovery / inheritance are not shipped).
- **#388** will make a leaked vault id no longer grant read access; unrelated to fund recovery but
  part of the same trust story.
