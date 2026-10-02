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

### Added

- **A roadmap in the docs.** Under Roadmap, the steps Konclave plans to take, in order, each with
  the GitHub issues where the work is tracked. Hover over an issue number, or reach it with the
  keyboard, to read its title; Escape closes it. On a phone the titles are listed under each step.
  The titles are kept with the page, so reading the roadmap sends nothing to GitHub until you open
  an issue. It is a plan, not a promise, and it carries no amounts.

### Fixed

- **The help page told you to check the recipient on the signing screen.** The address shown
  there is a label the coordinator writes when it builds the payment, and nothing yet checks it
  against what the payment actually pays (#610). The help page now says to compare the amount, which
  the device reads from the transaction itself, and not to rely on the address shown. Making the
  screen show the address that is really paid is #610's own fix.
- **The proof page called two transactions the first on mainnet.** They were Konclave's first spend
  from the Ironwood pool and Konclave's first browser-signed broadcast, not the first on Zcash. The
  page and `docs/PROOF.md` now say so, and the README names the other projects that run FROST.
- **The roadmap gave issue 120 a title that was not true.** It said production runs the released
  Zcash libraries. Production runs a July build of them; issue 120 is what moves `main` and production
  onto the released ones. The issue and the roadmap now both say so.
- **The landing named the previous desktop release.** It said v0.7.0 after v0.8.0 shipped. It now
  names v0.8.0, and the sentence reads the version from the same constant as the installer links,
  so the two cannot disagree.
- **The docs still named the previous desktop release.** The FAQ and the security page said v0.7.0
  after v0.8.0 shipped, because the landing was corrected and the docs were not. Both now read the
  version from one constant, and a test fails if the docs name any other.
- **Links in the docs were below the contrast WCAG asks for.** In the light theme, the blue of a
  link, of the label above each title and of the current section in the menu measured 3.9 to 4.4
  to 1, under 4.5 to 1. They now use the darker blue the app already uses on its own washes, and a
  test reads the colours from the stylesheet and measures them.

## [0.8.0] 2026-09-30

### Security

- **Changing your passphrase undid part of the check a device makes before it signs.** Each device
  keeps the address its vault uses for its own change, so that when it is asked to sign it can tell
  the vault's change from a payment to someone else. It is told that address once and refuses to be
  told again, so that a coordinator taken over later cannot label a stranger's output as change.
  Changing the passphrase on a device erased that record. The device did not refuse to sign because
  of it: the next screen that opened the vault found the record empty and took the coordinator's
  answer at that moment as the new one. So on that device the answer that counted was the
  coordinator's latest, not its first. A coordinator taken over at that moment could have named an
  address of its own as the vault's change, and the device would then have added its part to a
  payment that sends the leftover there, while its screen showed only the approved payment. That
  needed the coordinator to be compromised at the moment the record was refilled, on as many
  devices as the vault needs to sign. Changing the passphrase now replaces only the encryption and
  keeps everything else the device had recorded. Open since 2026-09-15, when the record was
  introduced, on devices where the passphrase was changed after that. A device that already changed
  it keeps the address it took afterwards, which is the right one unless the coordinator was
  compromised at that moment. We have no sign that it was used. Live on the web since 2026-09-30,
  and in desktop v0.8.0.

### Fixed

- **A password the app generated for you could be rated "fair".** About 3 in every 1,000 generated
  passwords had a character three times in a row, or a run like "defg", and the strength meter on
  the same screen marks both down. The password was still strong, but the screen said otherwise
  about a password it had just chosen. The app now keeps drawing until the meter rates the password
  strong, and the meter is unchanged.

- **The documentation described features that do not exist yet, and said the coordinator could not
  read what it can.** Member recovery and inheritance were listed as features; they are demos on a
  throwaway vault, and a lost seat cannot be rebuilt or replaced yet. A "quorum by value" was
  described that was never built. The coordinator was called blind, and payslip memos were said to
  be readable only by their recipient; in fact the coordinator holds each vault's viewing key and
  can read the balance, the payments, the amounts, the memos and the members' names, though it never
  holds anyone's part of the key and cannot spend. The docs also said votes were not authenticated,
  when every vote, proposal, payroll, rename and send is signed by the member's device and checked;
  and that a vault never dies from one lost seat, which is false in a 2 of 2. The docs, the landing
  screen and the payment screen now say what is true, including which desktop release is the latest,
  and that it is a pre-release that is not code-signed, with no Intel Mac build. The quorum on the
  web's create screen can no longer be set to 1, since the signing library refuses a quorum of 1
  when the vault's key is made. The older standalone `/net` and `/create` screens still offer it,
  and the coordinator still accepts it at registration (#589). The docs also gain a FAQ, a step-by-
  step guide to backing up your seat and one to restoring it on a new device, and a plain account of
  what to do when a seat is lost for good: create a new vault and move the funds with a signed
  payment while the remaining members still reach the quorum.

## [0.7.0] 2026-09-29

### Security

- **A device could be made to sign a payment other than the one on its screen.** Before it signs,
  each device works out for itself what the transaction is, and refuses a request that names a
  different one. In the second step of a signature the device receives a package from the member
  coordinating the round, and it checked the label on that package and not the package. The label
  and the contents travel as two separate things, and the signature is made over the contents. So
  the coordinating member, or anyone who took the coordinator's seat while it stood empty, could
  label a package with the approved payment and fill it with another, and an honest device would
  add its part to that other payment while its screen showed the approved one. Turning that into
  a payment still took a complete transaction spending the vault's funds, built with the vault's
  viewing key, which every member holds. This is the protection a group vault exists for, so it
  is the most serious fault recorded in this file. The device now hands the payment it worked
  out to the step that signs, and that step refuses a package made over anything else. There is
  no longer a way to ask for a signature without it. Open since the first signature made in a
  browser: the correction of 2026-08-27 closed the label and left the contents. Found on
  2026-09-29 by a review of our own claims, not by a report. We have no sign that it was used.
  Live on the web with this change, and on the desktop at its next release.

### Fixed

- **A refused vote or payroll named the wrong problem.** When the coordinator refused a vote because
  it carried a name that was not the seat which signed it, the screen said the vote no longer
  applied or conflicted with another. When it refused a payroll, for any reason at all, the screen
  said the address was not recognized. Both now say what was actually refused, and so does a name
  that is not on the vault's member list. It is the fault that was already fixed for the vote and
  then for the payment, left standing in the third place it lived.

- **Changing your own name failed on any vault with signed actions turned on.** The app signed
  votes, payments and sends, and never the rename, which the coordinator has required to be signed
  since early September. So the rename was refused every time, and the screen said only that it had
  failed. It is signed now, like the others, and the Members screen explains a refusal in the
  same words as the rest of the app.

- **The proof screen showed eight transactions when the record has nineteen.** The Proof screen and
  the in-app docs kept a list of their own, written when there were eight, and nothing tied it to
  the record in `docs/PROOF.md`, which went on growing. The screen now lists every transaction in
  the record, in the same order, and each one says how the key of its vault was made. That matters
  because the docs described the first payment as made with a key that was never whole, and its
  vault was one of six that a trusted dealer split, where the whole key existed on one machine at
  creation. The docs also still called a payment signed on two separate computers an open
  milestone, more than a month after it was made. Checking all of them from the screen now asks
  the public explorer for one at a time, since asking for nineteen at once gets some refused.

## [0.6.0] 2026-09-22

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

### Changed

- **Changing a vault's member list now needs the key that proves you can read the vault.** The list
  was already set once and never replaceable, which is what protected it; this closes the remaining
  sliver - the moments during a vault's creation before it is protected at all. Creating a vault is
  unaffected, because the list is claimed before the protection exists and the coordinator knows to
  allow that.

### Fixed

- **The payment screen offered money another proposal had already claimed.** The dashboard subtracts
  what open proposals are holding before saying the vault can pay; the payment screen did not, so it
  would accept an amount the dashboard had just said was impossible - and that payment could reach a
  quorum and then fail, or take the funds from the proposal that asked first. Two people proposing
  on the same day is not a corner case. Both screens now mean the same thing by "available".

- **Being blocked by a colleague's proposal now says so.** It used to read as "not enough", which is
  not true and sends you looking for money you have. It now shows the sum: what the vault holds,
  what is committed and to whose proposal, what is free right now - and that the funds come back
  when those are sent or refused. This is Konclave's own rule holding the money, not the network, so
  the screen says what is happening rather than implying the chain refused.

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
