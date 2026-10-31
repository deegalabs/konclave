# If every Konclave service disappears

> For a member of a vault, not for an operator. The question it answers: the site, the coordinator
> and the relay are all gone, so what can my group still do, and with what?
>
> Every step below was checked against the code or the document it names. Each one is marked
> **rehearsed** (it was run, and when) or **read, not run** (the code and the documents say so, and
> nobody has yet done it on a test vault). A later rehearsal on a test vault replaces those marks.
> This page promises nothing the code does not already do today.

The short answer first.

- **Your share stays yours.** It lives on your device, sealed under your passphrase, and in the backup
  file you downloaded. No service holds it, so no service disappearing can take it.
- **With the backups alone, the group can prove what it has and see the money, but not move it.**
  Seeing needs the vault's viewing key and scan height, which a backup made on a **Private** vault
  carries. Moving needs a coordinator, and today a coordinator cannot adopt an existing vault
  without the operator's own backup of it. That gap is #214, and it is written out plainly below.
- **Everything that ran as a service can be run again by anyone with the source.** The web app, the
  coordinator and the relay are in this repository, with their deploy guides.

## 1. What each member must already hold

| What | Where it is | Why it matters |
|---|---|---|
| **Your backup file** (`konclave-backup-<date>.konclave.json`) | wherever you saved it when you exported from Settings, or from the card at creation | It is the only spare copy of your share. Nothing else restores your seat. |
| **Your passphrase** | your memory, or wherever you keep it | The backup opens with nothing else. A passkey is a shortcut on one device, not a key to the file. |
| **Which kind of vault yours is** | the vault list shows a **Private** or **Open** badge | A backup made on a Private vault carries the vault's address, viewing key and scan height. A backup made on an **Open** vault carries the address only: it restores your **seat**, not the vault, and the money cannot even be seen from it. |

Each member holds their **own** file. Do not gather every member's backup in one place: it restores
full control to whoever holds the pile, which is the one thing the vault exists to prevent
(`docs/RECOVERY.md`, procedure A).

**Checked:** read in `ui/src/storage.ts` (`exportVault`, what the v2 export seals) and
`docs/RECOVERY.md` ("The complete recovery kit"). The viewing key and the scan height ride in the
export only when the device could fetch them, which an Open vault cannot (the coordinator refuses the
key to a vault with no read key). Not run for this page; the export's contents are covered by the
app's own tests (`ui/src/open-export.test.ts`).

## 2. What works from the backups alone, today

### Open the backup without Konclave

`scripts/open-export.mjs` in this repository opens a backup with nothing but Node.js: no Konclave, no
network, no packages. Copy the one file anywhere Node runs and:

```sh
node scripts/open-export.mjs konclave-backup-2026-10-31-1305.konclave.json
```

It asks for the passphrase on the terminal and **reports** what the file holds rather than printing
it: your share (yes/no), the vault's address, the viewing key, the scan height, the read secret. It
says in words when a backup restores the seat but not the vault. Add `--show-secrets` to print the
share and the keys themselves, and only then.

**Checked:** read in `scripts/open-export.mjs` and in `docs/RECOVERY.md` ("Opening an export without
Konclave"). The script's decisions are exercised by the app's tests against a real export the app
wrote (`ui/src/open-export.test.ts`); running it by hand against a backup for this page was **not
done**.

### See the vault with the viewing key

A viewing key reads the vault's whole history and balance and cannot move a coin. With it and the
scan height from a Private backup, a wallet that accepts a unified full viewing key shows the vault's
money. The one this project uses is `zcash-devtool` (the Zcash tools this product is built on, see
`engine/versions.lock`), with the command the coordinator itself runs when it rebuilds a wallet:

```sh
zcash-devtool wallet -w <a new folder> init-fvk \
  --name <any name> --fvk <the viewing key from the backup> \
  --birthday <the scan height from the backup> \
  -s zec.rocks:443 --connection direct
```

then `wallet sync` and `wallet balance`. **The `--birthday` is not optional**: without it the wallet
scans from today and shows an empty vault, and there is no rescan.

**Checked:** read in `docs/RECOVERY.md`, procedure B, step 3, which is where the command and the
warning come from, and in `helper-server/src` (the coordinator's wallet is initialised the same way).
**Not run from a member's backup for this page.** The warning about the birthday is not theoretical:
it is #434, found on a live vault.

### Prove a payment happened

The transaction ids of the vault's payments are on the public chain and need no service: any block
explorer shows them. What they do not show is who was paid or how much; that is what the viewing key
is for.

**Checked:** this is how `docs/PROOF.md` is verified (`scripts/verify-proof.mjs`). Rehearsed many
times, on every proof row.

## 3. What needs a service someone must run again

All three pieces are in this repository and can be run by anyone who can build it. None of them
needs a secret of the old deployment to start; a coordinator needs the vault's identity, which is
section 4.

| Piece | Where the guide is | What it needs |
|---|---|---|
| **The web app** (`ui/`) | `README.md`, "Try it", and `ui/README.md` for the build-time settings | Node.js and pnpm. `pnpm install && pnpm -C ui run build` makes a static site in `ui/dist`. Two settings at build time point it at a coordinator and a relay (`VITE_HELPER_BASE`, `VITE_RELAY_BASE`). The app also takes a coordinator address at run time, in Settings ("Coordinator"), so a group can point an existing build at a new coordinator without rebuilding. |
| **The coordinator** (`helper-server/`) | `deploy/helper/README.md`, and the short form in `DEPLOY.md` | A Rust toolchain and the two engine binaries whose checksums `engine/versions.lock` records (`zcash-devtool`, `zcash-sign`). The guide deploys to Railway; the container runs anywhere Docker runs. It holds each vault's viewing key and builds the transactions the quorum signs; it never holds a share. |
| **The relay** (`relay-server/`) | `DEPLOY.md`, "Blind relay" | A Rust toolchain or Docker. It carries sealed bytes between devices and keeps nothing on disk. One instance only: its rooms live in memory, so two copies would be two different relays. |

**Checked:** read in `README.md`, `ui/README.md`, `DEPLOY.md`, `deploy/helper/README.md`, and in
`ui/src/helper.ts` and `ui/src/screens/Settings.tsx` for the run-time coordinator address. The
coordinator and the relay deploys are **rehearsed** on every release (the current ones run from
these guides, `DEPLOY.md` says how to tell). Building the web app from source on a machine that
never had it is **read, not run** for this page.

## 4. What does not exist yet, said plainly

**A new coordinator cannot adopt a vault from the members' backups.** When a vault is created, the
coordinator mints its address and viewing key once, with randomness, and keeps them in its own
files (`registration.json`, and the scan height beside it). A coordinator started fresh has no way
to take an existing viewing key from a member's backup and serve that vault: registering the vault
again would mint a **new** address, and the money at the old one would stay where it is, visible with
the old viewing key and unreachable through Konclave. That path is #214, and it is not built.

So today, to move the money again after every service is gone, the group needs **the operator's own
backup of the coordinator's files** for that vault (`docs/RECOVERY.md`, procedure D: the vault's
`registration.json` and `wallet/keys.toml`), restored into a new coordinator by procedure B. That
backup is the operator's to take and keep; a member cannot make it.

**What this means for the money, in one sentence:** with every service gone and no operator's backup,
the group can prove the vault exists, see its balance and history, and show every member's share
is intact, and it **cannot send a payment from it until #214 lands or the operator's backup turns
up.** Whether the Zcash Foundation's command-line tools could sign a spend from the shares and the
viewing key without a coordinator is a question this page does not answer, because nobody has
rehearsed it on a vault created in the browser, and a page like this should not guess.

**Checked:** read in `docs/RECOVERY.md` ("Why the share alone is not enough", verified live on
2026-08-29; procedures B and D, the backup in D **rehearsed** on 2026-09-06 on the live volume) and
in #214's thread. The sentence about the money follows from those; it was not tested by losing a
coordinator on purpose.

## 5. What to do now, while the services are up

1. Export your vault from **Settings** on a device that can reach the coordinator, and keep the file
   and the passphrase apart from each other. Do it again after a passphrase change and when a
   member joins.
2. Check the file once with `scripts/open-export.mjs`: it tells you whether it carries the viewing
   key and the scan height, or only your seat.
3. If the vault is **Open**, know that its backups restore seats and not the vault; making it Private
   means re-creating it (#406).
4. Ask whoever runs your coordinator whether they keep the backup of procedure D, and where. Today it
   is the only thing that lets the vault move money again on a new coordinator.

Related: #214 (a coordinator adopting an existing viewing key), #308 (what recovery claims are
honest today), `docs/RECOVERY.md` (the operator's procedures).
