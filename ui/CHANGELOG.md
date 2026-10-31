# Changelog: the app

Written for the person who has to live with it: a treasurer holding real ZEC, not a reader of commit
messages. If an entry does not answer "what is different for me now", it does not belong here.

## What this file covers, and what it does not

This is the app itself: screens, the ceremony, the money gate, everything a member touches. It is
**not** a product; it is what two products ship.

- **The web** publishes it on every merge to `main`. There is no waiting and no version to install.
- **The desktop** bundles the same app inside a native shell and publishes on a tag.

So an entry here reaches the web immediately and the desktop at its next release. Recording it once,
where the change lives, beats writing it in two files and letting them drift, which is the failure
this repo keeps meeting in other forms.

The desktop shell (`src-tauri/`) and the shared Rust crates stay in the root
[CHANGELOG.md](../CHANGELOG.md), and `scripts/release.mjs --notes` assembles a desktop release body
from both.

## Which build is live

The web has no version to check, because it changes whenever `main` does. The app frame (the rail on a
computer, the More menu on a phone) and the landing name the exact commit instead, which is the honest answer to "do I have the fix?". Compare it with `main`.

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

### Security

- **A restored vault kept its viewing key readable on the device (#599).** From 2026-09-06 (#447), a
  device that imported a backup carrying the viewing key stored that key unencrypted in the app's local
  storage, next to the encrypted share and read secret. Anyone able to read that storage could read
  it without the passphrase: malware or another user on the computer, an extension with access to the site, or a copy of the browser profile. It cannot move funds, but it reads the vault's whole history,
  memos and payslips included. It is now encrypted under the passphrase, and a record that holds it
  in the clear is rewritten the next time the passphrase is typed on that device. Devices that never
  imported a backup, and the backup files themselves, were not affected.

### Added

- **A proposal states its facts.** Under the amount, the screen now says when the proposal was
  created, until when it can be approved (or that it has no deadline), the whole destination address
  with a copy button, and, once sent, how many confirmations the payment has, counted from the
  chain, or that it is not in a block yet. The address used to be shortened everywhere, the deadline
  appeared only in the list, and confirmations were nowhere on this screen. The deadline is given
  as a date and hour with the time left beside it; while the chain has not answered the screen says
  nothing rather than "not confirmed"; and the copy button names what it copies and announces
  "Copied" to a screen reader.
- **The proposals list puts what needs you first, keeps a sent payment until the chain confirms
  it, and says when it could not be read.** The list came in the coordinator's order, with no group
  for what waits on this member and no deadline order; a payment vanished from it the moment it was
  sent; and when the list could not be read the screen drew an empty desk, as if nothing were
  pending. Now "Needs you" comes first (your signature, then your vote, soonest deadline first),
  then what is with the others, then the sent ones until a block holds them; closed proposals sit
  behind a "Show closed" button; and a read that failed says so, with "Try again". Each row says
  what it waits for from you (your signature, your vote) and when your signature sends; the title is
  a link, the groups are headings a screen reader can jump to, and a proposal whose clock has run
  out leaves "Needs you" on the device before the coordinator notices (#292).

### Fixed

- **"Copied" is said only when the clipboard really took the text.** On Add funds (the vault's
  address and the payment link) and on the proof page (transaction ids), the copy button said
  "Copied" without waiting for the browser's answer, so a refused write (a page not in focus, a
  permission denied, an insecure context) still read as success, and a member could paste a stale
  clipboard value where they believed the address was. Both screens now wait for the write, say
  "Copied" only when it was confirmed, and otherwise say that it could not copy and to select the
  text by hand. The creation invite already did this (#313).
- **A vault can no longer be asked for with a quorum of 1 on the `/net` screen and in the ceremony.** The signing library refuses a
  quorum below 2, and the main create screen already stopped at 2 (0.8.0), but the older `/net`
  screen still listed "1 of 3", a config built by hand or by an older client still reached the
  ceremony, and when the library finally refused it, after every member had joined, the screen stayed
  on the roster with no message. Now the floor is written once (`quorumIsPossible`), read by the
  screen and by the ceremony: the `/net` select starts at 2, creating with an impossible quorum says
  so before anything is sent to the room, and a failure at the start of the ceremony is shown as a
  failed creation instead of disappearing. Still open: on the coordinator, registration accepts
  `threshold: 1`; and the main create screen's own check (`Ceremony.tsx`) still lets 1 through to
  the ceremony, which then refuses it (#589).
- **The spreadsheet's "Open" total no longer counts refused or expired proposals.** The Summary
  sheet took as open everything that was not settled, so a refused, expired or invalidated proposal,
  whose money never left, was added to "Open", and the figure disagreed with the one the screen
  shows. The Movements sheet now carries an "Open" column (yes for a proposal still awaiting
  approval or ready to sign), the Summary's "Open" sums that column, and the screen's total, its
  filter and the export read one rule. The TOTAL row of the Movements sheet added every row,
  refused and expired ones included, so it agreed with neither summary total; it is now what
  moved plus what can still move, the two summary totals added together (#302).
- **Loading takes the shape of what is coming.** Signers, Pay, Payroll and Settings showed a generic
  spinner while they loaded; they now draw a placeholder in the shape of the content (a roster for
  the signers, label and field for a form, headed sections for Settings), so the content lands
  where the placeholder was; only the caption line, when it appears, takes a line of its own. On
  these four screens a screen reader hears the word once, from one live region, not once per grey
  block; the word also appears as a caption when the wait passes 400 ms, and the blocks keep an
  outline under forced colours (#320).
- **Payroll checks whether it fits the way Pay does, and both say when the funds are only
  confirming.** Pay subtracted what open proposals already hold before accepting an amount; Payroll
  read the raw spendable balance, so two payrolls against the same funds both validated and the
  second died at signing. Both screens now draw on one rule (free = spendable minus what open
  proposals hold), and Payroll shows the same arithmetic, naming who holds the money. And when the
  vault holds the amount but part of it is still confirming, both say so ("{confirming} ZEC is
  still confirming. Propose it once that lands") instead of "exceeds the vault balance". The
  block is read from one live region the button points at, so a screen reader hears it appear,
  change and clear; the "after" figure is labelled as free funds and shows a dash while a
  reservation or confirmations are the block (#293, #352).
- **The proposal screen shows the amount exactly.** The figure at the top of a proposal, each
  payroll line and the send confirmation were rounded to four places, so a payment of 0.00009 ZEC
  read 0.0001 while the fee and the total beside it were exact and the signing panel read 0.00009.
  They now show every place down to the zatoshi. The amount sent was never affected (#777).
- **The members popover on the vault home closes with Escape.** Hovering or focusing "N members"
  opens the roster and the quorum; a keyboard user who tabbed onto the link got the popover over
  the page and could only close it by moving focus away. It now opens on hover and on focus and
  closes on mouse leave, on blur and on Escape, and the small gap between the link and the popover
  no longer closes it on the way to it (#602).

### Known limits

- The Dashboard keeps its spinner and still announces its loading twice, once per placeholder; it
  is not among the four screens above (#320).
- **The fix for #599 cannot take back a copy already made, and it needs the passphrase.** A viewing
  key cannot be changed, so a copy taken before the rewrite stays valid for the life of the vault. Removing the
  field does not promise the browser has wiped the old bytes from its files on disk. Unlocking with a
  passkey does not rewrite the record, because a passkey does not open what the key is encrypted
  under: on a device that imported a backup, type the passphrase once for each vault. An extension or script running in the page while the vault is unlocked can still read the viewing key.

## [0.16.0] 2026-10-30

### Security

These fixes reach a device when it runs this version. If the app says "New version available", press
Update once any signing in progress has finished. Your vault and your share stay on the device.

- **The app's side of the six signing fixes listed under Security in the root changelog.** The signing
  machine takes a signing request only from the device assembling the signature and does not let a
  second one replace the one in hand (#730); it checks each signature part on its own and names the
  signer of one that does not check out, with the new text `net.err.badShare` (#729); it holds the
  signing module's round handle and frees it as soon as the share is made, when a spend ends, when the
  device is re-armed and when the owner withdraws consent (#731); the signing demonstration and the
  share-repair demonstration pass the device's message to the module (#725); a new vault's sealed backup
  no longer carries the creation device key (#738); and a device checks its own name in the creation
  transcript, which runs on the devices that carry this build (#739).

### Added

- The proof screen lists two more mainnet transactions, the 21st and the 22nd: the first production send on the redeployed
  coordinator (block 3,527,232) and a send on the 0.15.0 coordinator (block 3,529,405). `docs/PROOF.md` carries the rows,
  and the counts in the documents say 22.
- **The app knows the NU7 network upgrade (block 3,543,405, about 6 November 2026).** The
  device accepts transactions built for it, in blocks of 25 seconds, and about 27 hours after its own
  estimate of the upgrade (between about 15 and 39 hours after the real one) it stops accepting
  transactions built for the previous one, which the network no longer mines. A pool crossing's
  expiry is read at the new scale of ZIP 318 (103,680 blocks after the upgrade, 34,560 before).
  Payments are paused around the upgrade rather than built for the wrong one, and after it a
  coordinator that is not updated yet refuses them.
- **A notice before the upgrade.** From about six hours before it until about a night after, the
  dashboard says that the network upgrades, that payments are paused for a while around it, and that
  nothing is lost and approvals stand. Until now a member learned it only when a payment was refused.
  The block number comes from the same table the device and the coordinator use, not from the app.

### Changed

- **The signing module reads a pool crossing's expiry at the scale of the network upgrade the transaction's
  header names, and reports the height of the last upgrade in its table.** A crossing's expiry (ZIP 318)
  is accepted only at the scale of that upgrade, so a header cannot borrow the other scale around the
  upgrade. The module is rebuilt (see the root changelog). The dashboard notice listed under Added
  reads the reported height.
- **The signing module in the web app is rebuilt on the stable NU7 crate line** (orchard 0.16.0, pczt
  0.10.0, zcash_primitives 0.31.0, and the crates that go with them; see the root changelog). The
  packaged module in the app is a new build of the same code against newer releases of those crates.
  What a member sees is unchanged, and the device's own recompute of the signature hash still matches
  the signer on the transactions it matched before.
- **The refusal around the upgrade says what is true in both cases.** Before it: payments are paused
  around the upgrade block, nothing was built, your vote stands and you will be asked to sign again
  after the upgrade. After it, if the coordinator is not updated yet: nothing was signed or sent, your
  vote stands until the proposal expires (72 hours), and you will be asked to sign again when the
  payment can be built. The refusal withdraws the signatures that were given, which "your approval
  stands" did not say. The old text promised a send as soon as the upgrade block was mined.

### Fixed

- **Small accessibility fixes on notices and the Receive screen.** The close button on a notice was
  smaller than a fingertip (now at least 24 by 24) and its label was English-only; "Copied" on the
  Receive screen was silent to a screen reader (now announced once, for either button); and a QR that
  could not be drawn left a blank square (now a sentence pointing to the address and the link). The
  rest of #320 (the app frame's live region and vault switcher) waits for the keyboard work on that
  file (#317, #662).
- **The proof page no longer offers a check that could not run.** Its "verify on-chain now" button
  asked an explorer's API, and the site's own security policy refused that request before it left,
  so pressing it always ended in "blocked", which reads as a broken claim. The button is gone; the
  page says how to check instead: the two explorer links on every transaction, and the
  `verify-proof.mjs` script for the whole list at once. A test now holds the page's network origins
  to the policy (#615).
- **The "page not found" and the crash screen now speak the member's language.** Both were
  English-only, with no way to translate them: a Portuguese member hit a dead link or a crashed
  screen and read it in the wrong language, at the worst moment. Both now read the dictionary; the
  crash screen reads it directly, without the rest of the app, so it still works when what crashed
  is the app itself (#318, part A).
- **The Members screen says when it could not read the list.** With the coordinator offline it
  drew an empty roster under "0 members", with no message and no way to retry, and every seat it
  did draw carried a "holds a share, votes" chip it had never checked. Now a list that was not read
  says so, says the vault and your share are still on this device, and offers "Try again"; the chip
  appears only on a list that was actually read (#315).
- **Import and export errors now appear in the member's language.** A wrong passphrase, a corrupt or
  incomplete file, a vault already on the device: each of those came straight from the storage layer,
  in English, on the screen of a member restoring the one copy of their seat. The storage layer now
  refuses with a code and the dialogs turn the code into a sentence from the dictionary, in
  Portuguese or English; the generic line stays as the fallback, and is still what a failure of
  the browser's own storage shows (#586).
- **An older shielded (Sapling) destination is refused, and the screens now say so.** The warning on
  the payment, payroll, people and recipient fields said such an address "works, but prefer a modern
  one", while the vault cannot pay it: the backend refuses a Sapling-only destination before any
  transaction is built. Every one of those strings now says the same true thing: this vault cannot
  pay an older shielded (Sapling) address; ask for a current shielded one (u1…). In the same pass the
  everyday screens stop naming pools and protocol terms: "Orchard" and "Sapling" read as "shielded"
  and "older shielded (Sapling)", and "sighash" as "signed digest (sighash)" (#127).
- **Closing a dialog that opened on a field returns focus to the button that opened it.** Remove,
  import and unlock a vault, the creation dialog, rotate passphrase and export all put focus in a
  field as they open; on close, focus fell to the page instead of the opener, because the dialog
  recorded where to return after the field had already taken focus. It now records the opener before
  any focus moves. The signing confirm and the lock overlay were not affected (#667).
- **The landing page and the loading placeholders read the dictionary.** The landing carried its
  own copy in both languages, outside the dictionary, so the test that keeps the two languages in
  step never saw it, and the loading placeholders announced "Loading" in English whatever the
  language. Nothing reads differently today; a sentence changed in one language can no longer be
  missed in the other, and a screen reader hears "Carregando" in Portuguese (#318, part B).
- **The spreadsheet export carries the transaction id and the memo, and exports what the screen
  shows.** The XLSX, the export meant for the accountant, had no txid column, so no row could be
  tied to the block explorer, and no memo; it ignored the state and kind filters, so a book
  filtered to settled payrolls exported everything, silently; an empty book produced a total that
  summed itself, which Excel opens with a circular-reference warning; and the file named the app as
  its author in the hidden document properties. Now every row carries its memo and its txid, linked
  to the public explorer; the export holds exactly the rows on screen, and its Summary names the
  active filter; an empty book exports zeros instead of formulas; and the hidden properties say
  nothing the Summary sheet does not. The CSV link still exports the whole book: it comes from the
  coordinator, which does not know the screen's filters (#302, with #301).

### Known limits

- The own-name check runs on the devices that carry this build.
- In the hidden properties of the spreadsheet export, the application is still named as Microsoft
  Excel. The library writes that line and the app cannot change it (#302).
- **The notice before the upgrade reads the chain tip the coordinator reports, and it goes away about
  14 hours after the upgrade even if the coordinator has not been updated by then.** It says nothing
  that depends on the update. A payment that moves funds between pools, built shortly before the
  upgrade, can keep its funds reserved by the network for weeks: "nothing is lost" is true, and "the
  funds are available again" is not promised.

- **The notice before the upgrade appears only on the dashboard, and only once the vault's balance has
  loaded.** The chain tip it reads comes with the balance answer, so a locked or protected vault that
  cannot be read yet, a read that failed, and the screens to propose or approve a payment show no
  notice. The refusal texts still apply there: a payment that the pause holds back is refused with its
  own sentence.
- **For some 15 to 39 hours after the upgrade a device can still warn that signing again could pay twice**
  about an earlier payment that the network already refuses. The device estimates the upgrade from its
  clock and stops accepting the old branch about 27 hours after that estimate; the coordinator, which
  sees the chain, already says the payment needs a new signature. A release that anchors the clock to
  the real time of the upgrade block shortens this.

## [0.15.0] 2026-10-26

### Fixed

- **An amount typed with a comma is accepted.** In Portuguese the payment screen refused `0,0005`
  and asked for a dot, although the Portuguese number format uses the comma. A comma used as
  the decimal point now reads as one, on the payment screen and in each payroll line, and the field
  keeps what was typed. The preview shows the amount as it will be proposed, and the dollar estimate
  under the amount no longer reads `0,5` as zero. An amount with two separators (`1.000,5`) is still
  refused rather than guessed, and so is a dot or a comma before exactly three digits when the
  whole part is not zero (`1.500` or `1,500`, which reads as 1.5 or as 1500), on the payment screen,
  in each payroll line and in a receive request: each refusal says what to type instead. `0.001` and
  `0,0005` are read as before. The amount in a receive request follows the
  same rule, so its link and QR code never carry more than 8 decimals.
- **Creating a vault no longer asks the coordinator for proposals it cannot have.** Every member got
  an error in the browser console during creation, because the list of payments was read before the
  vault was registered. It is read once the vault is registered.

## [0.14.0] 2026-10-23

### Changed

- **The device keeps the network upgrade a transaction was signed under (#638).** Its record of what
  it signed now stores the consensus branch it read in the transaction, beside the expiry, so a later
  upgrade is counted when it decides whether signing again could pay twice. Nothing changes until the
  next upgrade's row is added: an older record without a branch reads as NU6.3, which is true of
  every record that exists. When the earlier attempt is ended by an upgrade rather than by its own
  expiry, the confirm names the last block it can be mined in and when that is expected, and when
  the device has no turning point to give (a record that never stops counting) it says so instead of
  naming a time. Seven new texts (English and Portuguese), approved by the maintainer as written:
  `signing.againUntilEpoch`, `signing.againNoTime`, `error.needsNewSignature`,
  `error.fundsHeldUntil`, `error.upgradeHold`, `error.upgradeHoldCrossing` and
  `error.coordinatorNotUpdated`. The app words the coordinator's refusals by the `reason` it sends,
  also on `/net`, in both languages. None can appear yet.
- **The public roadmap is current as of 18 October 2026.** Step 1 says what is already measured
  (making one transaction's proof in a phone's browser, with the median times on three phones and a test anyone
  can run) and what is still to measure. The page no longer says a step starts only once the one before
  it is done: a step can start earlier, and the page says what each one waits on. The network upgrade
  (NU7, #638) is listed as current work outside the numbered order, and #567 carries its title as it
  reads on GitHub now.

### Fixed

- **The site names the 0.13.2 desktop pre-release.** The landing and the help named 0.13.1 after
  the 0.13.2 installers were published. The download buttons stay off until the desktop app is
  validated on each platform (#212).

## [0.13.2] 2026-10-17

### Fixed

- **Right after creating or joining a vault, the signing panel could stay on "Connecting".** A member
  who opened a payment on the same page, without reloading, saw "Connecting to the signing room" with
  no error, and the payment could not be signed on that device until the page was reloaded and the
  vault unlocked. The panel and the device's signer now ask the same question, whether the vault's
  share is unlocked here, so the creating device signs at once, as one that was unlocked does.
  Opening the vault from the list after a creation still asks for the passphrase once, as before
  (#696).

- **Any t of n devices can complete a send, without a fixed device starting the signing.** The
  signing used to be started by one fixed device of the vault, and when that device was not among
  the ones that signed, the others' signatures waited with no message. Now the device whose
  signature completes the quorum runs the send; a member who is present and has not signed never
  blocks it; the panel names the device that is sending; and once the payment is out, the panel says
  whose signature was not needed and the proposal whose vote was not needed. No member's share or
  funds were affected: it was a matter of a send not happening.

- **Add funds said nothing while it read the vault's history.** After the first load, the on-chain
  history refreshed without a sign, so "No transactions yet" read as an answer while a deposit was
  still on its way in. The history now shows when it is checking the network and when it last
  checked, on every refresh, and an empty list says a deposit can take a few minutes to appear.
- **Add funds showed an empty history while it could not read it.** The screen read the history
  behind the unlock prompt, where the read fails, and took the failure for an empty answer: a vault
  with transactions read "No transactions yet" until a later refresh, 20 to 40 seconds after the
  unlock. It now waits for the unlock and reads the moment it happens; a failed read keeps what the
  screen had, says it could not check, and is retried a few times over about 20 seconds. The
  dashboard took a failed read the same way for the list it checks payments against, and now reads
  it through the same rule.

- **Creating a vault looked frozen while it waited for the other members.** After a member protected
  their part, the screen showed one line of plain text until everyone had. It now says how many have
  saved and who is left ("1 of 3 saved. Waiting for: ana, bia."), with a small spinner beside it,
  and the same on the lab page.
- **Every backup of a vault downloaded under the same name.** A second copy replaced or shadowed the
  first. The file is now named after the vault and the date and time it was made, and carries no
  member's name.

- **A vault whose registration did not finish can be finished from its card.** If the coordinator did
  not answer, or did not accept the registration, at the end of creating a vault, the vault stayed
  without a deposit address and nothing on the device could finish it; answering "everyone saved" on
  the card only hid the warning. The card of such a vault now offers to finish registering it (after
  the same question about the members, or at once when this device already knew every member had
  saved), names the coordinator it will register with, and builds your backup copy in the same step.
  The question about a different coordinator applies only to vaults created from this version on,
  which are the ones that remember where they were created; older records cannot say. A vault made by an earlier version
  of the creation is still told to be recreated, not finished.

- **The site names the 0.13.1 desktop pre-release.** The landing and the help named 0.8.0, an older
  pre-release that predates the device's payment check. The version comes from one place, the latest
  published pre-release, and the help no longer calls it the latest version. The landing's download
  buttons stay off until the desktop app is validated on each platform (#212).

- **A device signs nothing in a transaction whose padding was never finished.** A coordinator that
  wanted to could have asked a device to sign a transaction whose padding spend still carried a
  dummy spending key, and the device would have taken that spend as its own: extra actions, a higher
  fee allowed for them, and a ceremony that fails when the signatures are applied, so nothing was
  sent; no key was exposed. The PCZT specification says a signer must refuse such a transaction. The
  device now does, before its share moves, and the signing screen says the transaction has a part a
  vault payment never has. The coordinators we run do not build one; we have no report that it
  happened, and we did not check. The rule is shared with the native signer (root CHANGELOG).

### Known limits

- **A vault sends under the new signing rule once every device that signs runs this version.** With
  an older app among the signers, a send can wait about four minutes and end with nothing sent;
  everyone then signs again, and reloading the older app's page brings the current one. When a send
  fails, devices on the other version (older or newer) do not take that device's withdrawal, and can
  sign again only when the signatures expire (ten minutes). Nothing is signed twice and nothing is at risk. The desktop app has
  no updater yet (#606).
- **If the device sending a payment closes after the signing has started**, the others wait: close
  the signing panel and open it again, then sign again. A started signing has no way to be called
  off yet (#284).
- **The `/net` page still starts its signing from the vault's first seat**, so there that seat must
  be present.

## [0.13.1] 2026-10-15

### Changed

- **A screen opened while the vault is busy keeps what it showed.** When the coordinator answers that
  the vault is busy for a moment (often a payment being sent), the dashboard keeps the last balance,
  the payment and payroll screens keep the last balance or, with none read yet, say a payment can be
  proposed once the vault is free, and the receive screen keeps its transactions; all of them update
  on their own. Before, such a screen could read "Wallet not connected" or block a payment until a
  reload.

### Fixed

- **A refused payment read as money to verify on the dashboard.** The movements table showed it with
  a minus sign and a "verify" link, as if it had left the vault. A payment that never went out now
  shows its state (refused, expired, awaiting) and no minus sign; only a payment that left shows the
  block it landed in, or that it is on its way.
- **The update banner named the version already running, and on a phone it sat under the bottom
  menu.** It now says which version replaces which, sits above the menu, and the page keeps room for
  it.
- **The version was only in Settings.** It is now in the app's frame (the side menu on a computer,
  the More menu on a phone) and on the landing page.

## [0.13.0] 2026-10-15

### Security

- **A device checks more of a transaction before it signs.** In earlier versions a device checked what
  a transaction pays (since 0.10.0) and not much else about it. A coordinator could build the
  approved payment with an expiry far in the future and keep the signed transaction to broadcast
  later; could set a fee above the network rule, within the ceiling the device allowed; and could ask
  the devices that approved a payment to sign a second, different transaction for it, so that both
  could go out. A device now refuses a transaction that expires outside the window its own clock
  allows, that is built for another network or transaction version, or whose fee is not exactly the
  network rule (ZIP 317). On this device, it refuses to sign a second transaction for the same
  approval without the explicit confirmation of the member who signs. We have no report that any of this
  was used; we did not check. What a member can notice: a device may refuse to sign with one of a
  few new messages, each saying what to check.
- **Creating or joining a vault needs an up-to-date app.** An app cached from before 0.12.0 could
  still create a vault the old way, the one the 0.12.0 notice describes, and the coordinator gave
  that vault an address. The app now sends, with every registration, a field that identifies the
  version of the app, so the coordinator can ask an outdated app to update; when it does, this app
  says so before a creation or a join starts, and asks to reload (or, on the desktop app, to install
  the latest release from the project's releases page). The coordinator does not refuse yet; a
  notice period comes before it does (Known limits).

### Changed

- **The signing panel shows the whole destination address and the network fee before you sign.** The
  address is no longer shortened, the fee and the total that leaves the vault are shown as the
  estimate they are, and the confirm repeats them. A payroll's fee appears once its lines are known.

### Known limits

- **Apps up to v0.12.0 cannot say they are out of date.** Once the coordinator asks for an
  up-to-date app, one of these creating or joining a vault may not finish: it may get no address, so
  nothing could be received into it, without the app saying why. Reloading the page brings the
  current app. The desktop app has no updater yet (#606): install the latest release by hand. The
  plan: the app side ships first, desktop installer included, and the coordinator asks only after a
  notice period.
- **The exact-fee check uses the network's current fee per action.** If the network lowers it (ZIP
  2009 proposes this at block 3,590,000), devices on this version would refuse honest payments until
  they update. Plan: a build that follows the network's fee by block height, out before block
  3,590,000. Status: planned, not started.
- **The `/net` page does not have the signer's newer checks**, nor a content check of its own; use
  the vault's own signing screen for payments.
- **A device that signed a payment does not answer a new attempt at that same payment until the page
  is reloaded.** Nothing is signed meanwhile; reload the page, then sign the new attempt.

## [0.12.0] 2026-10-12

### Security

- **Creating a vault now ends with a code every member reads to every other.** Before anything
  secret is exchanged, each device shows the same short code and the list of members; you read it
  with each person on the list (a call or in person) and confirm only if everyone reads back the same
  code. The invite is now a link (or a long code) with a PIN that is always required and travels
  separately. When what the devices announce does not add up, the ceremony stops and no vault is
  created. Vaults you already have keep working as before.

### Changed

- **A new vault's address appears once every member has saved their part.** Until then each device
  shows the vault without an address, so nobody can fund a vault one of its members does not hold.
  If a device was closed before that, the vault shows as "Not finished" in Your vaults: confirm with
  each member that they saved, then finish it there.
- **An invite link opens Your vaults with the invite already filled in.** You type your name and the
  PIN you received separately; the link is removed from the address bar once read. Old links that
  pointed elsewhere still work.
- **Every member now gives a name to create or join a vault.** The others read it when they compare
  the code, so a blank name can no longer leave someone unsure who is on the list. Two members with
  the same name are flagged at that step.

### Fixed

- **The vault's name now reaches every member.** The name the creator gives a new vault used to stay on
  the creator's device: the others saved it with a generic name, and the coordinator could record a
  generated one instead. Now every member sees the name on the code screen and saves the same one.
  Vaults that already exist keep the names they were saved with.
- **Clicking outside the create window, or pressing Esc, no longer throws a vault creation away.**
  Until you saved your part, those used to close the window and lose it, with no way back; now the
  window asks first ("Keep creating" is the default), and a reload asks too.
- **Closing the create window at the end opens the new vault.** It used to return to a list that did
  not show it until the page was reloaded; while the backup copy has not been taken, it asks first.

## [0.11.0] 2026-10-12

### Changed

- **The proof page lists the twentieth transaction, and the roadmap page says what the 2026-10-04
  release closed.** The new row is the first transaction made in production after the released engine went
  live on 2026-10-04 (`1c53fe50…`). The roadmap's first step no longer lists the coordinator defect
  that the 2026-10-04 release closed, and says the other one was narrowed and is still open.

### Fixed

- **A payment the group had signed could wait with nobody sending it.** The device whose signature
  completes the group's signatures is the one that sends. Each signature carries the time on its
  signer's clock, and a device dropped, without saying so, any signature dated even a second ahead of
  its own clock. When the first signer's clock ran fast, the member who signed last never saw the
  signatures complete, while the others waited for that member to send: nothing was sent and nothing
  said why. A signature also stayed counted after it expired, so signing the same payment again ten
  minutes later, with the signing screen still open, named no one to send either. Now, among devices
  whose clocks are within two minutes of each other, every device decides who sends from the room's
  order and the times the signatures carry, so they agree, including a device that opens the payment
  later: a signature dated up to two minutes ahead counts, and one further ahead is noted in the
  browser console; a signature expires at the same point on every device; an old one posted again
  does not come back; and after a payment names its sender, no other is named for ten minutes by the
  times the signatures carry, so a member who signs again while the send may still be running is not
  a second sender (a member whose clock runs up to two minutes fast can be named up to two minutes
  sooner, and that device then finds the payment sent). After those ten
  minutes the next signature names a sender, with the signatures still standing, however many members
  signed: before, once more members had signed than the vault needs, or a member signed again over
  their own standing signature, nobody was named again. Before asking for the send, the device checks
  whether the payment already went out. When the coordinator refuses because another device sent it,
  the screen shows it sent, where it used to show "Could not send: proposal is not ready to send" and
  withdraw every signature; when the proposal expired, was refused or lost an approval, the screen
  says which.
  Every open signing screen shows the payment as sent once it is, asking the coordinator one request
  at a time and nothing from a hidden tab. The screen says "Sign and send" only when this device's
  signature would name it the sender, says someone is sending only while a sender named in the last
  ten minutes may be, and keeps its count current as signatures expire; a signature the device
  ignores is noted in the browser console. Since 25 August; found on 3 October when a test send on
  staging stalled three times (#626). Every member of a vault needs this version: a device on the
  previous one still drops a signature from a fast clock.
- **The signing screen says what it knows when a send's outcome is unclear.** When the coordinator
  stops answering during a send, or answers that the payment may be on the network, the screen says
  it does not know, keeps the signatures, offers no retry, and says to check the book first and when
  the payment can be signed again; it used to call some of these a failure and offer to try again. A
  vote the coordinator could not take for a reason of its own is no longer called "no longer
  applies". The `/net` page reads a send's reply by the same rule.

### Known limits

- **A send whose outcome is unclear waits even when nothing went out.** The device that sent can
  sign the payment again only after a reload. The other members are not told the outcome is unclear;
  their screens show the payment sent once the coordinator records it.
- **Who sends can still stall in a few cases (#626, #334).** Closing the signing screen, or
  reloading, while a send waits leaves the payment waiting about ten minutes before a new signature
  can send it, and about twenty when the members' clocks are up to two minutes apart: a signature
  from the slower clock, given as soon as its button returns, can still fall inside the ten minutes
  measured on the faster one. A member who signs again from a second device whose clock is behind the
  first, or after setting the clock back, is ignored by every device until the button returns ten
  minutes later; the browser console says so. With clocks more than two minutes apart, a device drops
  the other's signature, as before this version, and with three or more members two devices can each
  believe they send. The coordinator refuses to send a payment it has recorded as sent, and the device
  that asks second sees it sent. A device that opens a payment after its room passed 512 messages
  reads only the latest ones and may decide differently from the others. The member whose clock runs
  fast should sign last.

## [0.10.0] 2026-10-04

### Security

- **A device checks the payment it signs against the transaction itself.** Before it adds its part
  of a signature, your device now reads each payment, the address it names, its memo and the network
  fee from the parts of the transaction its signature covers, compares them with what the group
  approved, and refuses on any difference, on a payment its recipient could not open, and on a fee
  above the network's standard fee for the transaction's size.
- **A device that refused a payment stays refused.** Nothing that arrives afterwards moves it to
  sign the refused transaction, and a part counts as signed only when the member device that
  assembles the signature announces it and the signature checks out on this device.
- **The vault's own address is the one this device recorded.** The device treats outputs that pay
  the vault itself as change, and takes that address from its own record of the vault, made when it
  was created or first opened. It refuses to sign while it has none. See Known limits for what that record still trusts.
- **The app signs only for the vault you opened,** and switching vaults from the side rail starts a
  new signer for the new vault.
- **Add funds, the dashboard and Settings show the address this device recorded.** Add funds warns
  when the coordinator answers with a different one, without showing that one, and shows no address
  when this device has none recorded. Importing a backup made before 30 August no longer takes its
  address or its payee book from the file, and refuses a file whose vault id is not its group key,
  whose sealed part is not a share, or whose vault secret is not 32 bytes. The offline backup
  checker (`scripts/open-export.mjs`) applies the same rules.

All five are live on the web with this change. If Konclave was already open, tap Update when it
says a new version is available, or close every Konclave tab and open it again: reloading one tab
keeps the version you had. The commit in the footer tells you which version you are running. On the
desktop they arrive with its next release. What each one closed, and since when, is in the
disclosure: https://forum.zcashcommunity.com/t/konclave-a-group-vault-on-zcash-frost/57218/21.

### Changed

- **The signing screen lists every payment and the fee.** While your device signs, it shows what
  it read from the transaction: each payment with its exact amount and the address it names, the
  change returning to the vault, and the network fee. An output is called change only when it pays
  the vault itself, and one that names no address and does not pay the vault is shown as such. It
  used to show only the first recipient, so a payroll showed one beneficiary of several.

### Fixed

- **The signing screen could judge a payment by another vault's balance.** The Sign button and the
  fee estimate read the balance, and the number of lines in a payroll, of whichever vault was
  selected in the browser, so with vaults open in two tabs they could follow the other one. They now
  read the vault being signed. Since 25 August.
- **A device that refused to sign showed an internal code.** The message read "Could not send:
  net.err.notApproved", with a Try again button under it, and a few minutes later it was replaced
  by the coordinator's own failure, inviting you to sign again. A refusal now says, in your
  language, that your device refused and why; stays on screen; shows what the device read from the
  transaction, when it could read it, so you can compare it with the proposal; and offers no Try
  again button, because a refusal is not a failed send. When the transaction does not match what
  was approved or what it claims to be, or carries a fee or a part it should not, the message says
  not to try again and to tell the other members. When the device could not load what was approved,
  or its own record of the vault, the refusal says so, says that the coordinator can cause that,
  and asks you to reload rather than to try again. A message the device ignores, while the real one
  may still come, is shown as a note beside the progress instead of as a refusal.

### Known limits

- **The /net page signs without this check.** It is an older signing screen, not tied to a proposal,
  so it has no approved payment to compare with and signs what it is given. Sign payments from the
  vault's desk, not from /net.
- **What your device compares the payment with still comes from the coordinator (#567).** Your
  device now knows what a transaction really pays, but the approved lines it compares against are
  fetched from the coordinator when it signs, and a vote is tied to the proposal, not to its exact
  content. A coordinator that changed a proposal after it was approved could still build a payment
  that matches the change. Until #567 is fixed, a payment the quorum signs is only as safe as the
  coordinator.
- **You decide on the proposal; your device reads the transaction afterwards.** The amount and
  recipient on the screen where you sign come from the proposal record. Your device's own reading
  appears once the signature is under way, and it refuses on its own if the transaction differs
  from what was approved; there is no pause to look at it first.
- **The fee limit grows with the size of the transaction, and the coordinator chooses the size.**
  The device refuses a fee above the network's standard fee for the transaction's actions, and
  refuses padding the coordinator signed itself. But the coordinator chooses how many parts of the
  transaction the vault is asked to sign, how many of the vault's notes to spend and how many
  pieces to split the change into, and each extra part can raise the standard fee by 0.00005 ZEC,
  paid to the network. Nothing on the device limits how many; today the only limit is the relay's
  cap on the size of one message.
- **Your device learned the vault's own receivers from the coordinator, once.** It uses them to
  tell the vault's change from a payment to someone else, and it keeps the first answer it got:
  when the vault was created, or the first time it opened the vault. A coordinator that was already
  compromised at that moment could have named an address of its own. The vault's address among them
  is also the one Add funds shows for deposits, so the same limit applies there.
- **A backup made before 30 August is only partly sealed.** Its vault id and group key sit outside
  the encryption, and Konclave checks them against each other but cannot check them against the
  share. After restoring an old backup, compare the vault fingerprint in Settings with another
  member's. Better, download a new backup and delete the old copies: an old file stays importable
  wherever it is kept. A backup made since 30 August seals all of it.

## [0.9.0] 2026-10-03

### Added

- **A roadmap in the docs.** Under Roadmap, the steps Konclave plans to take, in order, each with
  the GitHub issues where the work is tracked. Hover over an issue number, or reach it with the
  keyboard, to read its title; Escape closes it. On a phone the titles are listed under each step.
  The titles are kept with the page, so reading the roadmap sends nothing to GitHub until you open
  an issue. It is a plan, not a promise, and it carries no amounts.

### Changed

- **The signer in your browser is built on the published Zcash libraries.** pczt 0.9.3 and orchard
  0.15.5, the same releases as the coordinator's engine, in place of a July development snapshot
  (#120). Nothing changes on screen; the code that reads and signs a payment is now the released
  library.

### Fixed

- **The help page told you what to check on the signing screen, and neither version was a check.**
  It said to check the recipient there, and then, from 2 October, the amount. The coordinator
  builds what that screen shows, so neither is yet a check on the coordinator (#610), and a vote is
  not yet tied to the exact content of a proposal (#567). The help page now says that, until both
  are fixed, a payment the quorum signs is only as safe as the coordinator, and a new question in
  the FAQ says what that means. What to do: keep only small amounts in Konclave. It has not been
  independently audited, and #567 and #610 are still open.
- **The signing desk said you check the destination and the amount before signing.** What you
  confirm there is the payment as the proposal records it, and that is not yet a check on the
  coordinator (#567, #610). The note now says what you confirm.
- **The help page said the coordinator cannot spend, and that the safety of spending lies only in
  who signs.** The coordinator cannot move funds on its own, but it builds every transaction the
  quorum signs, and the devices that sign cannot yet check that it built what was approved. The
  help page now says so, and lists it as not guaranteed yet rather than under what is guaranteed.
- **The help page did not say what happens if our servers go down.** A new question in the FAQ
  does: no payment can be made while they are down, and if we lost a vault's data for good, only a
  member's backup made on a Private vault since 6 September 2026, while our coordinator was
  reachable, would still hold what a rebuild
  needs. The rebuild itself is not built yet (#214, #613).
- **The help page said the desktop app seals your part of the key under a key held in the system
  keychain.** It does not. The desktop app uses the same app code as the browser, in a native
  window, and keeps your part of the key the same way: encrypted under your passphrase, in the
  app's own storage. Keeping it in the system keychain is planned. Another line on the same page
  said the desktop seals it the way the local build does; it now says the same as this one.
- **The help page said the relay never learns who a payment pays.** That holds once every member
  has unlocked the vault on their device, which registers a public key of that device with the
  coordinator; until then the signing request crosses the relay unsealed. The help page now says
  so.
- **The help page said the desktop app can use your own coordinator or run with none.** It
  offers both, but it does not include the local orchestrator yet (#212), and its security policy
  most likely blocks a coordinator other than ours (#612). The help page now says which modes are
  not confirmed to work there.
- **The help page said each device checks the payment before it signs.** It shows the payment, and
  what it shows is not yet checked against what it signs (#610). The proof section and the dry-run
  note now say so.
- **The proof page said a device checked that a payment was the approved one before signing it.**
  The transaction it points to is the one where the device recognised the vault's own change, which
  the chain itself cannot show. What a device
  shows is not yet checked against what it signs (#610), and an approval is not yet tied to the
  exact content of the proposal (#567). The proof page, `docs/PROOF.md` and `docs/CLAIMS.md` now say
  so.
- **The roadmap said a signing device already checks recipients and amounts.** Step 0 now says
  that a signing device does not yet check what it shows against what it signs, nor the fee or the
  memos (#610), and the titles of #610 and #583 read as they do on GitHub. It no longer lists the
  server's engine among our defects: this release moves the coordinator onto the engine built from
  the code's main line (#120).
- **The proof page called two transactions the first on mainnet.** They were Konclave's first spend
  from the Ironwood pool and Konclave's first browser-signed broadcast, not the first on Zcash. The
  page and `docs/PROOF.md` now say so, and the README names the other projects that run FROST.
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
  including a protected one. Whoever replaced it chose the new key, so from then on they could read
  what that key protects and, on a vault with no device registered for sealing, its viewing key. It
  gave no part in signing, and it shut the members out: balance, ledger, proposals, members and
  history all refused, for everyone, on their own vault. And it would not have healed on its own,
  because nothing in the app ever re-registers that key after a vault is created; recovery would
  have been a hand-made request by someone who knew. Changing the key now requires the current one.
  Setting the FIRST one still requires nothing, which is what lets a new vault be protected at all.
  Open since the read protection shipped on 2026-08-28; no vault was affected.

- **Anyone holding a vault's link could take over a seat nobody had claimed yet.** Registering a
  device with the coordinator asked for no proof at all, so whoever had the vault id could claim any
  seat whose own member had not yet unlocked on a device - and from then on could vote as that
  member, while the real member's own device was refused with "that seat is taken". A seat taken
  this way could act on the coordinator as that member (propose, approve, refuse, rename, ask for a
  send). It could not sign: a signature needs that member's key share, which stays on the member's
  device. What it broke is the part that matters most, which is that an approval on screen is that
  member's approval. Claiming a seat now requires the key only a seated member's device can derive,
  the same one the private reads already ask for. A vault that has never been protected still
  registers devices as before. Checked on the live vaults: none was in the state where this could
  have been used - every one either had all its seats claimed or had none - but the window opens
  whenever members join at different times, and on one vault it had been open for two weeks.

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
