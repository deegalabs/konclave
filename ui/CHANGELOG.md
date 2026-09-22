# Changelog — the app

Written for the person who has to live with it: a treasurer holding real ZEC, not a reader of commit
messages. If an entry does not answer "what is different for me now", it does not belong here.

## What this file covers, and what it does not

This is the app itself — screens, the ceremony, the money gate, everything a member touches. It is
**not** a product; it is what two products ship.

- **The web** publishes it on every merge to `main`. There is no waiting and no version to install.
- **The desktop** bundles the same app inside a native shell and publishes on a tag.

So an entry here reaches the web immediately and the desktop at its next release. Recording it once,
where the change lives, beats writing it in two files and letting them drift — which is the failure
this repo keeps meeting in other forms.

The desktop shell (`src-tauri/`) and the shared Rust crates stay in the root
[CHANGELOG.md](../CHANGELOG.md), and `scripts/release.mjs --notes` assembles a desktop release body
from both.

## Which build is live

The web has no version to check, because it changes whenever `main` does. The footer names the exact
commit instead, which is the honest answer to "do I have the fix?". Compare it with `main`.

## Categories

Same meanings as the root [CHANGELOG.md](../CHANGELOG.md): `Security` always says what was exposed
and for how long; `Fixed` only if a member could have hit it; `Known limits` survives the release
rather than being a draft note. Anything a member cannot notice does not go in at all.

## Where the earlier entries are

This file starts on 2026-09-20. App changes before that date are in the root
[CHANGELOG.md](../CHANGELOG.md), which is where everything lived. They were not moved: rewriting
history to tidy it is how context gets lost.

---

## [Unreleased]

### Fixed

- **The payment screen never noticed that money had arrived.** It read the vault's balance once,
  when it opened, so anyone who got there a moment too early - a deposit still confirming, a
  payment still settling - was told they could not send and stayed told, however long they waited,
  until they thought to reload the page. Nothing on the screen suggested reloading. It now keeps
  looking, and the block lifts by itself.
- **The 25/50/75/Max buttons did nothing when the vault had nothing to send.** They looked
  available and answered a click with silence. They are now visibly unavailable, which is the
  honest version of the same information.
- **The balance card counted the same money twice.** Under a total of 0.0006 it said
  "+0.0006 confirming", which reads as 0.0012 - but the total already includes it. The plus sign
  is gone.

### Fixed

- **The dashboard called a payment confirmed while it was still waiting to be mined.** The green
  "confirmed" mark went up the moment a payment was broadcast, and it could never have been right:
  it read the proposal's own record, and that record has no way to learn that a block arrived. So
  the mark said confirmed for a payment sitting in the queue, on the page a treasurer uses to check
  the books. It now reads the vault's own transactions and says **confirmed with the block number**
  only when there is one, and **"sent, awaiting a block"** until then - and if it cannot tell, it
  says the lesser of the two rather than guessing. Being slow to call something confirmed costs
  nothing; being early tells someone their money arrived when it has not.
- **An open payment page asked the coordinator for news every eight seconds, forever.** It was
  waiting for a change to a sent payment that nothing was ever going to make, so the request
  repeated for as long as the page stayed open. Confirmation now comes from the transactions, which
  is where it lives.

### Changed

- **Changing a vault's member list now needs the key that proves you can read the vault.** The list
  was already set once and never replaceable, which is what protected it; this closes the remaining
  sliver - the moments during a vault's creation before it is protected at all. Creating a vault is
  unaffected, because the list is claimed before the protection exists and the coordinator knows to
  allow that.

### Security

- **Anyone holding a vault's link could lock its own members out of their books.** The key that
  proves a device may read a vault could be REPLACED by whoever had the vault's id, on any vault,
  including a protected one. Nothing leaked and no money could move - what it did was shut the
  members out: balance, ledger, proposals, members and history all refused, for everyone, on their
  own vault. And it would not have healed on its own, because nothing in the app ever re-registers
  that key after a vault is created; recovery would have been a hand-made request by someone who
  knew. Changing the key now requires the current one. Setting the FIRST one still requires nothing,
  which is what lets a new vault be protected at all. Open since the read protection shipped on
  2026-08-28; no vault was affected.

### Security

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

## [0.5.0] 2026-09-21

### Fixed

- **When a passkey did not open a vault, the screen could not say which of four things happened.**
  It now says, in one calm sentence each: the passkey no longer matches this vault and should be
  removed and created again, this device cannot offer the shortcut at all, it did not answer, or it
  was not finished. The one that matters most is the first - it means the device answered and its
  key changed, which no amount of retrying fixes - and it was previously indistinguishable from
  pressing cancel. This is readable on the phone itself, which is the point: the shortcut is
  per device, so the device that fails is a phone, and a phone has no console.
- **Unlocking with a passkey could sit on "Waiting for this device" for a minute and then do
  nothing.** However it ended - the prompt never appeared, it was cancelled, the device's passkey no
  longer produces the same key - the button went quiet and the vault stayed locked, with nothing
  said either way. Failing was always meant to cost nothing and send the member to their passphrase;
  saying nothing at all does not do that, it reads as broken. It now waits a shorter and more
  honest time, and when it does not work it says so in one quiet line pointing at the passphrase
  field already on screen. The passphrase was never affected.
- **A member could be locked out of voting entirely, with no way back in.** Approving or refusing
  anything answered "this device could not prove it holds the seat", however many times the vault
  was unlocked, removed and imported again. The device registers itself with the coordinator the
  first time it can prove it holds its share, and that registration was happening only while a
  proposal was already open on screen - so a member who had not been through a signing ceremony
  before the vault started requiring signed votes could never register, and could never take part in
  the proposal that would have let them. Registering now happens when the vault is unlocked, which
  is the moment it is actually true, and a registration that fails now says so instead of passing in
  silence. Found on a live 2-of-3 vault where one of three members had been unable to approve
  anything for a fortnight.
