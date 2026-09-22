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
