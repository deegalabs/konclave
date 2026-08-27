# Postmortem: no vault could sign a second payment, for about seven hours

**Date:** 2026-08-26 evening to 2026-08-27 01:28 BRT · **Duration:** ~7 hours across three distinct
defects, measured from the first failed send to the first successful one after the last fix.
**Impact:** every vault on the hosted path. Any vault that had already sent once could not send
again until its relay room aged out an hour later. No funds were lost and nothing was broadcast
that should not have been - the failure mode was always a refusal to sign.
**Status:** all three fixed and live (#355, #357, #359). One hardening item deferred and named below.

---

## What happened

A payroll broadcast normally (`82499b46…`). Every send after it failed, in three different ways, in
this order:

1. The panel opened on the **next** payment still showing the previous one as sent, with its txid,
   and signing failed with `The participant's commitment is incorrect` from `frost-rerandomized`.
   Reloading replayed the same failure.
2. After the first fix: both members present, **"1 of 2 signed"**, no error at all. Nothing on
   screen was wrong; the quorum simply never closed.
3. After the second fix: the ceremony completed and the helper refused the broadcast with
   `IronwoodSign(InvalidExternalSignature)`.

## Cause

One defect, in three places, and it is the same sentence each time: **a reader started at
`since = 0` and was handed the previous ceremony as if it were live.**

The signing room is **permanent per vault** - `sha256("konclave-sign " + groupKey)` - and the relay
keeps 512 messages per room with a one-hour idle TTL. So the room always holds the last ceremony.

| # | where | what it replayed | what it looked like |
|---|---|---|---|
| #354 | `ui/src/net.ts`, `RelaySession` started at 0 | a finished payment's `sreq` and round-1 commitments | FROST refuses stale commitments mixed with fresh nonces |
| #356 | the fix for #354 cut history off entirely | nothing - it **starved** the arming tally, which is rebuilt from history by design | stuck at "1 of 2", silently |
| #358 | `orchestrator/src/send.rs:452`, `let mut since = 0u64` | the **previous payment's signature response** | signatures injected into the wrong PCZT |

#358 is the sharpest: `publish_request` **returns the sequence it posted at**, and its own docstring
says why — *"so a caller can start polling for the response strictly after it."* The caller
discarded it. And the stale signatures passed every check on the way in: `into_sigs` validates that
the response covers exactly the requested spend indices, and it did, because both transactions had
their single real spend at the same action index. Only the cryptography could tell.

## Why it was not caught earlier

- **The spec said it could not happen.** `docs/spec/ceremony-protocol.md` described the transport as
  *"short-poll with a cursor over seq (dedup, replay-immune)"*. The cursor dedups **within** a
  session and does nothing about a session that starts at 0, which every new reader did. Three bugs
  came from believing that line; it is now invariant **I5**, with the rule written out.
- **The contract existed only in comments.** Two docstrings said "each in its OWN fresh signing
  room" and "fresh session per payment is the contract". The room never changed, and `rearm()` was
  called from **nowhere in production** — only from its own unit test.
- **The unit tests passed because they build a fresh in-memory relay per payment**, which is exactly
  the condition production does not meet.

## What was done

Fixed in three PRs (#355, #357, #359), each with a test proven to fail without its fix. The rule is
now invariant I5 in the ceremony spec: every message in a permanent room is either replay-safe and
**needs** history (`armed`, `unarmed`, `rejoin`) or replay-unsafe and must be dropped from it (the
FROST rounds and the helper's request/response). Any new message type has to pick a row.

First successful send afterwards: `78fe7dfa…`, ceremony start to signature response in **7 seconds**.

## What is still open

1. **`/net` never got the mitigation** (#363). `screens/NetVault.tsx` is a second, diverged
   ceremony driver: its wire type declares the rounds **without** the `CeremonyTag`, so the tag that
   separates two transactions is erased at the exact boundary meant to enforce it, and its
   `onMessage` never takes the `historical` flag. Whether its consumed-seq set incidentally saves it
   is **unknown** and needs a live two-tab session with a relay capture.
2. **Origin authentication** (#63). Everything here bound the *content* of a request. Nothing
   authenticates who sent it.

## Honest notes

- **My fix for #354 caused #356.** I cut history off at the transport, which starved a tally that is
  rebuilt from history by design — and whose docstring said so, in the file I was editing. I read
  the code I was changing and not the code that depended on it.
- **I guessed "multi-note" and was wrong.** The error said `at index 1`, and I read it as a count of
  spends. `spends=[1]` is one spend at **action index 1**; index 0 is usually a dummy pad. That
  hypothesis cost time and sent me reading the multi-spend path, which was never involved.
- **I read ceremony code for too long before reading the relay room.** The room is public, the
  ceremony is in it in order, and where it stops is where the bug is. It settled #354 and #358 in
  one look each, after code-reading had produced two wrong hypotheses. That is now the first step in
  the diagnosis notes, not the last.
- **While fixing this I found a second hole and it was not this incident's.** `onSp` overwrote the
  device's own H1-verified sighash with the coordinator's wire value, unchecked, and the share is
  computed over the coordinator's SigningPackage — so a device displayed the transaction it had
  verified and signed the one it was handed. Fixed in the same PR. `CLAUDE.md` had claimed for weeks
  that a hostile helper could not swap the transaction under a signer; that was true of round 1 and
  not of round 2, and the paragraph now says when the guarantee actually started holding.
