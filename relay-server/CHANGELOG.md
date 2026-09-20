# Changelog — blind relay

Written for the person who has to live with it: a treasurer holding real ZEC.

## What this service is, and why it has no version number

The relay is a blind mailbox. It carries sealed messages between the devices in a ceremony and can
read none of them. It is deployed by hand, is never downloaded and never installed, so a semantic
version would be a number that moves when someone remembers to move it.

It cannot even report a commit, and the reason is worth knowing: it is built by Railway from an
uploaded directory, so there is no git checkout and no `RAILWAY_GIT_COMMIT_SHA`. A commit stamp
would read `unknown` every time, which is worse than nothing because it looks like an answer.

What it reports instead is a digest of the sources it was compiled from:

```
curl -s https://konclave-relay-production.up.railway.app/health
```

That answers the question that actually matters — *is the running relay built from THIS source?* —
and it needs no platform metadata and no step anyone has to remember. **It is not an attestation.**
Anyone who can replace the binary can make it report whatever digest they like; it detects a stale
deploy, not an adversary.

**`railway redeploy` re-uploads the OLD image.** The path is: rebuild, swap `bin/`, `railway up`,
then verify by asking `/health` what it was built from.

## Categories

Same meanings as the root [CHANGELOG.md](../CHANGELOG.md).

## Where the earlier entries are

This file starts on 2026-09-20. Relay changes before that date are in the root
[CHANGELOG.md](../CHANGELOG.md). They were not moved.

---

## Unreleased
