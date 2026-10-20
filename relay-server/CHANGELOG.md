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

## [Unreleased]

### Security

- **A client could use up another client's request budget at the relay.** The relay refuses a
  sender that makes too many requests in a short window (`429`). That budget was counted under a key
  built from a string the requester supplied, and the per-address and per-sender budgets were kept
  in one table, so a supplied string could name someone else's budget. A request that named another
  address, or another member's tag, was counted against that other budget, and once it was used up
  the other party's own requests were refused for as long as this went on. Anyone who knew an
  address could do it to that address, and anyone who had a room's id could do it to a member's tag
  there. It affected whether requests were answered, not what the relay carries. The code keyed the
  per-sender budget this way from 2026-07-15 and the per-address one from 2026-08-22, the earliest
  dates it could have been exposed. We have no report that it was used; we did not check. What a member can notice: nothing, unless a ceremony
  stalled with no message to explain it. Every budget is now scoped to the address the relay
  attributes to the request. A poll whose `from` tag is longer than the 128 bytes a post allows is
  refused with `400`, as a post is, and different spellings of one address (upper or lower case,
  compressed or expanded IPv6, IPv4-mapped IPv6) are one address. The hosted relay has run this
  since 2026-10-19 (`/health` reports `64f79ca010322c31`).

### Known limits

- **The address the relay and the coordinator count a request under is only as good as the
  forwarding header they are given.** Both take it from the first hop of `X-Forwarded-For`. Where the
  platform in front of one of them keeps a value the client sent, a client can still choose which
  address its requests count under, and the fix under Security reaches no further than that. Tracked
  in #400.
