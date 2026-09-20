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
