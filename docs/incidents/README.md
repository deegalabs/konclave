# Incidents

A record of the times Konclave broke, written so the next person does not have to rediscover why.

## The rule

**Every incident gets a postmortem, and it is registered only after the maintainer approves it.**

An incident is anything that made the product wrong or unavailable to someone who was not testing
it on purpose: a broken send, a service that stopped answering, a screen that lied about money, data
exposed that should not have been. A bug caught before it shipped is an issue, not an incident.

The flow is fixed, and the order matters:

1. **Restore the service first.** Diagnosis can wait; a vault that cannot pay cannot wait.
2. **Write the postmortem while it is fresh**, as a draft, outside the repo (`temp/` is gitignored).
3. **Show it to the maintainer.** It is registered only when he approves it — the record is his,
   and a postmortem published without him is a statement he did not make.
4. **Then commit it here**, and link it from the issues it names.

## What it must contain

Impact before cause. How long, and how it was measured rather than estimated. The cause with a
`file:line`. What was actually done, and what is *still open* — a postmortem that ends at "fixed"
when the root cause is untouched is worse than none, because it retires the alarm and keeps the
hazard.

## The part that is easy to skip

**It names the mistakes of whoever wrote it, not only the system's.** Every incident here has a
line that begins with something someone got wrong: a fix that caused the next outage, a wrong
hypothesis held too long, a check reported as green that was red, a file changed three times
without reading the loop at the top of it.

That is not ceremony. Two of the three defects in `2026-08-26-signing-replay.md` were the same
mistake in different places, and the third was introduced by the fix for the first. None of that is
visible from the code, and without it the next person repeats it.

## Template

```markdown
# Postmortem: <what a person experienced, not what the code did>

**Date:** · **Duration:** (measured, and say how) · **Impact:** (who, how many, funds at risk?)
**Status:** (restored / still open — and is the ROOT CAUSE fixed, or only the symptom?)

## What happened      the observable failure, with the evidence gathered
## Cause              file:line
## Trigger            what set it off, if that differs from the cause
## Why it was not caught earlier
## What was done
## What is still open  numbered, in the order it helps
## Honest notes        what the author got wrong
```
