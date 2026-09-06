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

Recovering a vault so a member can **sign again against the same on-chain address** needs the
member's **share export** — and, since #447 and #480, that export carries what it used to be missing:

| what a rebuild needs | where it comes from |
|---|---|
| the member's sealed share | the export |
| the vault's **address** and **UFVK** | the export (#447 — before that, only `registration.json`) |
| the **scan floor** (`birthday`) | the export (#480 — before that, nowhere the member had) |
| the quorum (`t`/`n`) | decoded from the share bundle itself |
| the change receiver | derivable from the UFVK |

**What is still only on the helper**, and is correctly not in the export: `wallet_dir` (a path on the
helper's machine) and `account` (a uuid the helper's wallet database minted — a rebuild runs
`init-fvk` and gets a new one).

> **Why the scan floor is not optional.** A wallet rebuilt with the right viewing key but no
> birthday starts scanning at the CURRENT height and never sees a single note the vault already
> holds. There is no rescan. It does not look like a failure — it looks like an empty vault, and the
> UI tells the treasurer to add funds. That is #434, and until #480 the export did not carry the
> number even though the helper had it all along.

### Why the share alone was not enough (verified live)

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

Pull a local copy of every vault's view-only metadata. Two files per vault, and both are needed:

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
roster, the creation date, **your share**, the vault's access secret `S`, the beneficiaries, and the
**viewing key**. Nothing identifies the vault from outside the ciphertext — not even its id.

```js
// abrir.mjs — opens a v2 export with nothing but Node's own crypto.
//   node abrir.mjs export.json 'your passphrase'
import { readFileSync } from 'node:fs'
import { webcrypto as c } from 'node:crypto'

const [file, passphrase] = process.argv.slice(2)
const b = JSON.parse(readFileSync(file, 'utf8'))
const unhex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)))

const base = await c.subtle.importKey('raw', new TextEncoder().encode(passphrase),
  'PBKDF2', false, ['deriveKey'])
const key = await c.subtle.deriveKey(
  // `kdfIters` comes FROM THE FILE. An export written before that field existed has none, and
  // 210000 is what it was sealed with (#435).
  { name: 'PBKDF2', salt: unhex(b.salt), iterations: b.kdfIters ?? 210000, hash: 'SHA-256' },
  base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
const plain = await c.subtle.decrypt({ name: 'AES-GCM', iv: unhex(b.iv) }, key, unhex(b.cipher))
console.log(JSON.stringify(JSON.parse(new TextDecoder().decode(plain)), null, 2))
```

**A wrong passphrase throws.** AES-GCM authenticates, so it does not decrypt to garbage — it
refuses. The same is true of a file that has been altered by a byte.

**What this gets you.** The payload contains the share, the address, the viewing key and the scan
floor — everything a rebuild needs (see *The complete recovery kit* above). What it does not contain
is the helper's `wallet_dir` and `account`, and neither is portable: one is a path on another
machine, the other a database id a rebuild re-mints.

> **A v1 export** (no `version` field, or `version: 1`) is a different shape: the metadata is in the
> clear and only the share is sealed. The same derivation opens it; the fields differ. #405 replaced
> it precisely so a leaked backup would reveal nothing, including which vault it belongs to.

## Open work

- **#214** wants the fix: the export should also carry the UFVK + address, and the helper should gain
  a **restore/adopt** path that accepts a client-provided UFVK instead of re-deriving. Until then,
  procedure D is mandatory for any funded vault.
- **#308** tracks the recovery-claim honesty pass (member-recovery / inheritance are not shipped).
- **#388** will make a leaked vault id no longer grant read access; unrelated to fund recovery but
  part of the same trust story.
