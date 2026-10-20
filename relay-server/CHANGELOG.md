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
  since 2026-10-19 (its `/health` then reported `64f79ca010322c31`).

### Changed

- The relay bounds the message bytes it holds, per room and in total, and a poll's answer with
  them. What counts is what a message takes in a poll answer: its `data` and its `from` tag as
  JSON writes them (a quote, a backslash or a control character takes two or six bytes) plus 64
  bytes for the object around them. A room keeps at most 4 MiB of that. Past it the room's oldest
  messages leave first, as they already do past 512 messages, and the message just posted stays.
  The relay keeps at most 256 MiB across all rooms. A room is *active* while someone has posted
  to it or polled it in the last 45 seconds, and *idle* after that. When a post would take the
  relay past 256 MiB, room is made in this order, stopping as soon as the post fits: idle rooms
  lose their messages, the one idle longest first and its oldest messages first, and keep their
  sequence numbers; then active rooms that hold more than 384 KiB lose their oldest messages,
  the one with the most above 384 KiB first, and never below the newest messages that total
  384 KiB; then the room being posted to drops its own oldest. A post into a room already at its
  own ceiling counts only what it adds, so it takes nothing from other rooms. Making room costs
  time in proportion to the number of messages held, not to their size. The numbers are built so
  that with every other room held at 384 KiB a post of a whole room's size still fits, and a post
  is not refused for want of room. For ceilings that do not meet that bound the relay would
  answer `503` with `{"error":"relay_full"}`, decided before anything is removed; with these
  numbers it does not, so `relay_full` stays at 0 and is there to show a change of ceilings. A
  poll still returns every message after `since` in one answer, which the room ceiling bounds.
  `/health` carries `fill`, the share of the 256 MiB held in steps of 10 percent, worked out at
  most once a minute, and `relay_full`, how many posts have been answered `503` since the
  process started. The hosted relay has run this since 2026-10-19 (its `/health` reports
  `f8dc88d0970337a3`).

### Known limits

- **The address the relay and the coordinator count a request under is only as good as the
  forwarding header they are given.** Both take it from the first hop of `X-Forwarded-For`. Where the
  platform in front of one of them keeps a value the client sent, a client can still choose which
  address its requests count under, and the fix under Security reaches no further than that. Tracked
  in #400.
- **An active room is protected down to 384 KiB, not whole.** When the relay's 256 MiB are held,
  an active room that holds more than 384 KiB loses its oldest messages first. This reopens the
  rule that an active room is never touched. A device that joins or rejoins such a room reads a
  shorter history: the first `seq` it sees is not 1, and the oldest message it misses may be one
  other devices had not read yet. A device that opens the vault again can lose the other devices'
  `rejoin` messages that way, so it may not know which seat each of them holds: it counts fewer
  devices present, and a send whose completing signature is its own does not move on and fails
  after the wait, until those devices announce themselves again by reopening the payment. A
  ceremony whose request is older than the newest 384 KiB of its room loses the request; what a
  member sees is a send that does not move on, then fails after the wait, and starting it again
  publishes the request again. Nothing is sent. The floor keeps whole messages, up to 384 KiB in
  all: messages of the largest size a post may carry (a little over 128 KiB once counted) are
  kept two at a time. 384 KiB is sized from the largest ceremony a vault can run, so one
  ceremony fits under it:

  | Message | Number | Size, with 64 per message |
  |---|---|---|
  | the helper's request, at the 128 KiB cap | 1 | 128.2 KiB |
  | the coordinating device's `sreq` carrying the PCZT, while not every device has registered its key | 1 | 79.8 KiB |
  | one spend: 5 `s1`, `sp`, 5 `s2`, `signed` | 13 | 3.3 KiB each, 42.3 KiB |
  | the devices' `net-sign-response` for 13 spends | 1 | 2.1 KiB |
  | `rejoin` and `armed` from 5 devices | 10 | 2.8 KiB |
  | **one ceremony** | | **about 255 KiB** |

  The PCZT sizes come from the repository's test vectors (12,184 bytes for 2 actions, 21,092 for
  4, extended linearly), the FROST message sizes were measured, five devices is the most a
  screen creates, and thirteen spends is the most a request of 128 KiB can hold. A request
  sealed to the devices is smaller, about 152 KiB all told. A vault of more than five devices,
  which the protocol allows and no screen creates, can run a ceremony larger than the floor.
- **The ceilings count message bytes, not the memory the process uses.** The presence list, the
  request-limit counters, the room ids and the per-message overhead in memory are not counted.
  One poll of a room at its ceiling takes about twice its answer for as long as the answer takes
  to write (the copy of the messages and the answer; measured 2.01 times). The worker pool is 8
  to 64 threads by default and up to 256 when `KONCLAVE_RELAY_WORKERS` sets it, and the
  allocator may keep the memory of the largest answer each worker has served: with 64 workers
  and 256 MiB held the process was measured at about 740 MiB resident, beyond the 256 MiB. The
  hosted relay sets `MALLOC_ARENA_MAX=2`, which cut that to about 260 MiB in the same test; neither
  figure has been measured on the hosted relay. The numbers, 4 MiB, 256 MiB and 384 KiB, are
  starting values, not derived from the memory limit of the container, which has not been measured.
- **A room can lose messages its devices have not read yet after far fewer messages than under
  the 512-message rule.** It holds about 32 messages of the largest size a post may carry (128
  KiB). A device that reads after that sees a first `seq` that is not 1.
- **The ceilings are shared by everyone who can post.** There is no byte quota per address yet.
- **A restart still drops every room.** Sequence numbers start again from 1 afterwards. That is
  not addressed here.
