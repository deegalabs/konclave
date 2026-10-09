# Changelog — coordinator (helper)

Written for the person who has to live with it: a treasurer holding real ZEC.

## What this service is, and why it has no version number

The coordinator is deployed by hand — a binary is built, dropped into `bin/`, and pushed with
`railway up`. It is never downloaded, never installed, and nobody ever asks "which version am I
on?". A semantic version here would be a number that moves when someone remembers to move it, which
is the kind of number that lies.

What it has instead is a build identity it reports itself:

```
curl -s https://konclave-helper-production.up.railway.app/api/health
{"helper_commit":"9487cdc","helper_built_at":"...","name":"konclave-helper","status":"ok"}
```

That commit is the answer to "is what production runs the same as what `main` says?" — a question
that had no answer until it was added, during a week when the deployed binary was nine days behind
`main` and nothing said so. So entries here are dated and name the commit they went out with, rather
than being grouped under a release that does not exist.

**`railway redeploy` re-uploads the OLD image.** The path is: rebuild, swap `bin/`, `railway up`.
Then verify by BEHAVIOUR — ask `/api/health` which commit answered — not by the deploy log.

## Categories

Same meanings as the root [CHANGELOG.md](../CHANGELOG.md): `Security` always says what was exposed
and for how long; `Fixed` only if a member could have hit it; `Known limits` survives rather than
being a draft note. Anything a member cannot notice does not go in at all.

## Where the earlier entries are

This file starts on 2026-09-20. Coordinator changes before that date are in the root
[CHANGELOG.md](../CHANGELOG.md), mixed in with the web app's — which is the reason this file exists.
They were not moved: rewriting history to tidy it is how context gets lost.

---

## [Unreleased]

### Security

- **How the coordinator registers a member's device was hardened.** The details are held back for
  now: they will be written up when they are published, and this entry will be extended then. What a
  member or operator can notice is under Known limits. Takes effect when this build is deployed.

- **The coordinator's handling of a send that does not finish cleanly was hardened.** The details
  are held back for now: they will be written up when they are published, and this entry will be
  extended then. What a member or operator can notice is under Known limits. Takes effect when this
  build is deployed.

- **How the coordinator publishes a signing request was hardened.** The details are held back for
  now: they will be written up when they are published, and this entry will be extended then. What a
  member or operator can notice is under Known limits. Takes effect when this build is deployed.

- **How the coordinator saves a vault's own files was hardened.** The details are held back for now:
  they will be written up when they are published, and this entry will be extended then. Takes effect
  when this build is deployed.

- **Defects in the coordinator's write checks were fixed.** The details are held back for now: they
  will be written up when they are published, and this entry will be extended then.
  What a member or operator can notice: a request the coordinator now
  refuses gets a plain error, and **the coordinator needs `KONCLAVE_RELAY_BASES` set, to the relays
  the apps use, or it refuses every send** (see `DEPLOY.md`). Takes effect when this build is
  deployed.

- **A member could approve a payment in another member's name.** Once a vault requires signed
  actions, every vote carries a signature that proves which seat sent it. The coordinator checked
  that signature and then recorded the vote under the name written in the request, which the
  signature does not cover. So a member signing correctly for their own seat could send a second
  vote carrying a colleague's name, and it was recorded as that colleague's approval. On a vault
  that needs two approvals, one person could make a payment show as approved by both. Creating a
  payment or a payroll had the same fault: it could be recorded as proposed by someone else. No
  money could move this way - signing a payment needs the real key shares, and each device still
  asks its owner to confirm that specific payment. What it broke is what that confirmation rests
  on: the owner was being asked to sign something the screen said the group had approved. A vote, a
  payment, a payroll and a rename are now recorded under the name the member list gives the seat
  that signed them, never under the name the request carried. A request under another member's
  name is refused; one that differs from the list only by a space at its edge is accepted and
  recorded as the list spells it. Signed votes were merged on 2026-09-06 and signed payments and
  payrolls on 2026-09-07, and this was open from the start. On 2026-09-28 signed actions were on in
  two vaults on the production service, both of them the project's own test vaults. Takes effect
  when this build is deployed. **It closes this route and not every route to the same result: see
  Known limits.**

- **Anyone holding a vault's link could lock its own members out of their books.** The key that
  proves a device may read a vault could be REPLACED by whoever had the vault's id, on any vault,
  including a protected one. Nothing leaked and no money could move - what it did was shut the
  members out: balance, ledger, proposals, members and history all refused, for everyone, on their
  own vault. And it would not have healed on its own, because nothing in the app ever re-registers
  that key after a vault is created; recovery would have been a hand-made request by someone who
  knew. Changing the key now requires the current one. Setting the FIRST one still requires nothing,
  which is what lets a new vault be protected at all. Open since the read protection shipped on
  2026-08-28; no vault was affected.

- **Anyone holding a vault's link could take over a seat nobody had claimed yet.** Registering a
  device with the coordinator asked for no proof at all, so whoever had the vault id could claim any
  seat whose own member had not yet unlocked on a device - and from then on could vote as that
  member, while the real member's own device was refused with "that seat is taken". No money was
  ever reachable: signing needs the real key shares and always did. What it broke is the part that
  matters most, which is that an approval on screen is that member's approval. Claiming a seat now
  requires the key only a seated member's device can derive, the same one the private reads already
  ask for. A vault that has never been protected still registers devices as before. Checked on the
  live vaults: none was in the state where this could have been used - every one either had all its
  seats claimed or had none - but the window opens whenever members join at different times, and on
  one vault it had been open for two weeks.

- **The coordinator had no limit on how fast, or how often, anyone could ask it for things.** The
  relay has refused floods since August; the coordinator never did, because the limit lived in the
  relay's own code. Two things were open. Anyone could send requests as fast as they liked. And
  creating a vault the coordinator had never seen ran its heaviest work and wrote to its disk every
  time, with no ceiling. Nothing could be read and no money could move this way: what was exposed
  is the service itself, which one source could slow down for everyone. Both now have a limit per
  source address: 300 requests every 10 seconds, and 5 new vaults an hour. What is counted is the
  vault, not the request, because every member's device registers the vault at the same moment
  when it is created: a group of any size creating a vault counts once, however many devices take
  part. The health check is never limited. A ceiling on the disk as a whole is still open. Open
  since the coordinator was first hosted. Takes effect when this build is deployed.

### Known limits

- **A device's registration, once it holds a seat, no longer changes by itself.** Unlocking again on
  the same device sends the same registration and changes nothing. A member whose seat is registered
  with a key that is not their device's cannot put it right by unlocking any more: it takes the
  operator at the desk, and `docs/RECOVERY.md`, procedure F, says how (by **replacing** the record,
  never by removing it first). A device that registered for sealing before seats existed can still
  gain its seat once, and whoever registers it first keeps it (#577).
- **A vault whose device registry cannot be read refuses governance writes.** A vote, a proposal, a
  rename or a send answers 503 with "this vault's device list cannot be read, so nothing can be
  changed until the operator restores it"; the viewing key and a sealed send are held back too, and
  the file is never rewritten from empty. Reading the vault's balance, proposals and ledger keeps
  working. The coordinator lists such vaults in its boot log (`device registries: ... UNREADABLE`).
  Before this change the same file was read as "no devices" and the vault accepted unsigned writes.
  `docs/RECOVERY.md`, procedure G.
- **A device key must now be one the coordinator can use.** A comms key it cannot seal to (a
  small-order point) and a write key that is not a canonical, non-weak Ed25519 point are refused with a
  400, as is a seat outside `1..total`. Registrations already on the volume are not re-checked. This
  does **not** stop a member from registering many keys of their own, which can still push a signing
  request past the relay's size limit or turn sealing on early: that needs a proof of the share, which
  is #577.
- **A send from a vault whose members' devices are not all registered needs a seat's signature.**
  A vault where every device record is in place sends as before (what is counted is device
  records, not seats). A vault where some are missing still sends when a seat signs the send, which
  every vault with a registered write key already requires. A vault with no registered write key
  and an incomplete set of device keys answers a send with 409, "this vault still has members whose
  devices are not registered; open it on a current build so a seat can sign the send". Until every
  device is registered, a signing request still reaches the relay unsealed.
- **A send waits for the quorum for at most 600 polls of about a second each** (the default is
  unchanged, 300). The build, the proof and each call to the relay are not time-limited, so this is
  not a promise about how long a send holds its vault.
- **A vault whose read key file cannot be read refuses every read until the operator restores it**
  (`docs/RECOVERY.md`, procedure H), and the boot log lists such vaults.
- **A signed write's nonce is limited to 64 bytes.** The app sends 36.

- **A payment can be held as "not settled", and a hold has no button.** After a send that did not
  finish cleanly the coordinator keeps a record of it on its volume (`send-attempts/`, public data
  only) and answers a new Send for that payment with "an earlier attempt to send this payment is not
  settled; it may already be on the network, do not retry yet". The hold ends by itself: when its
  transaction is mined the payment shows as sent (the next Send records it, and so does a read of the
  vault's proposals or ledger once the coordinator's wallet has synced past it, which a balance read
  does), and when the transaction can no longer be mined - its own expiry
  plus 10 blocks has passed - the next Send goes on. How long that takes depends on the transaction:
  about an hour for most payments, and for a single payment of a round amount (0.01, 0.02, 0.05,
  0.1 ZEC and the like, from a vault that still spends Orchard-pool funds) roughly one to two months.
  That figure is read from the engine's code and has not been measured on mainnet.
  **Do not make a replacement payment while one is held**: the held one may still be mined, and both
  would be paid. In a vault with a single note the wallet already counts that note as spent for the
  same time, so nothing else can be funded meanwhile.
- **Some holds have no way out of their own.** A transaction with no expiry; a wallet the coordinator
  cannot sync or read; a record it cannot read; a payment held past its own 72-hour deadline that is
  never mined (it reads expired). These need a founder at the desk, and `docs/RECOVERY.md`, procedure
  E, says what to check first.
- **The record needs a volume that can hard-link and sync a directory.** The coordinator says at boot
  whether its volume can, and how many payments are held. A volume that cannot refuses every real send,
  before any device is asked to sign.
- **Reading a vault can now write.** Reading its proposals, ledger or ledger CSV records a payment that
  is found mined (in `proposals/` and `ceremonies.jsonl`), and only while a payment is held. It
  looks at most once every 15 seconds per vault (it keeps the time in `last_promote`). Anyone who backs the volume up or reads it by hand as
  "read-only" should know.
- **The other members' devices can still say "Nothing was broadcast. You can sign again."** after a
  send that errored, because their screens decide that wording from the kind of error, and the error
  texts this coordinator now sends are not among the kinds they know. The coordinator refuses the
  repeat either way. Fixing the wording is the web app's.

- **One member can still make a payment read as approved by the group, by two other routes.** Found
  while reviewing the fix for a vote recorded under another member's name. While a vault still takes
  unsigned actions, anyone holding its id can record an approval under a member's name, and it keeps
  counting as that member's once the vault requires signatures, until that member votes on the
  payment. Their device shows it as theirs to sign, and a payment recorded that way can be given no
  deadline. Every vault takes unsigned actions from its creation until its first device registers
  (#575, narrowed in this release and not closed by it). And a member can register a device for
  a colleague's seat if that colleague has not opened the app since signed actions began, and then
  approve as them (#577). What is not yet trustworthy on its own is
  the line that says who approved. A third route, a vote and a rename sent at the same instant
  (#576), is closed in this release.

- **Two members with the same name count as one.** A vote replaces the earlier one recorded under
  the same name, so when two seats share a name, or names that differ only by spaces at the edges,
  their approvals leave one, and a vault that needs both of them cannot reach approval. Renaming one
  of two members whose names differ only at the edges clears both their approvals on payments not
  yet sent or expired, so both approve again, and where the two names are identical it renames both
  seats. Names that differ by more than that, chosen when the vault is created, avoid all of it, and
  a rename can no longer make two seats share one. Recording the seat with each vote would tell them
  apart; that is not built.

- **A name recorded on a payment under no member is reserved.** A rename to it is refused with
  "that name is already recorded on a payment", and since payments are never deleted it stays
  reserved; another spelling works. Such a name reaches a payment only while a vault takes unsigned
  actions, or as an old spelling of a member's own name.

- **A send refused for the relay shows the coordinator's own words.** A coordinator deployed without
  its relay setting, or with the relay spelled differently from what the app sends, refuses every
  send with an English message that the app shows as it comes, untranslated, and with nothing a
  member can act on. The apps send the relay the coordinator is configured with, so a member meets
  this only when the deploy step was missed or mistyped; `DEPLOY.md` has the check for both.

- **The app counts recorded names, not members.** A payment can show "2 of 2" and its quorum
  reached while the coordinator counts one approval and refuses to start its signing, and the
  ledger and its export list every recorded name as an approver. The coordinator's count is the one
  that decides.

- **A vault that requires signatures but never recorded a member list counts every name on a
  payment.** Its votes are refused, since there is no list to bind a signature to, but names
  recorded before it required signatures still count, and a signed send can start the signing for
  them.

- **If a limit is ever reached, the app does not say so.** It treats the refusal like a missing
  answer, so a screen can come up empty or name the wrong problem until it is reloaded. Nobody
  reaches either limit by using the product: one member sends about 4 requests every 10 seconds
  and an office of five with two tabs each about 42, against a limit of 300.

### Changed

- **The coordinator's boot log now reports its send records.** One line says whether the volume can
  hold them, one how many payments are held and how many of those have a record it cannot read, and
  one each (vault prefix and proposal id, up to 20; an unreadable record is marked).

- **Changing a vault's member list now needs the key that proves you can read the vault.** The list
  was already set once and never replaceable, which is what protected it; this closes the remaining
  sliver - the moments during a vault's creation before it is protected at all. Creating a vault is
  unaffected, because the list is claimed before the protection exists and the coordinator knows to
  allow that.
