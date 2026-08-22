# ADR-0010: Quorum redundancy — default to `n > t`, allow `n === t` with a warning

Status: accepted (2026-08-22)

## Context

A vault's quorum is `t`-of-`n` (threshold `t`, total `n` devices/members). With **`n === t`**
(e.g. 2-of-2, 3-of-3) there is **no redundancy**: if a single device/share is lost or destroyed,
the vault can never reach quorum again and the funds are **locked forever**. This is not a bug — it
is the FROST threshold guarantee working — but for the target user (an ordinary treasurer) it is a
severe, silent footgun. It bit us in testing: a 2-of-2 vault with one seat's share on a device the
owner no longer used was, by design, unspendable.

Redundancy (`n > t`, e.g. 2-of-3) has a **present** benefit independent of any recovery feature: if
one device is lost, the remaining `t` still form a quorum and can move/migrate the funds. It is also
the precondition for **social recovery** (RTS): rebuilding a lost share needs `t` helpers among the
**remaining** members, so `n - 1 >= t`, i.e. `n > t`. Social recovery itself is proven in the core
but not yet wired to a live vault (#58).

FROST permits `t === n`, and it is a legitimate configuration for some trust models (a strict
two-party escrow, "maximum control, no recovery by design"). Forbidding it outright would impose a
product opinion as a hard wall and remove valid setups. Per the project's honesty principle
(distinguish product lock from protocol guarantee; do not paternalize), the choice is a **product
default + guidance**, not a protocol constraint.

## Decision

- **Default new vaults to `2-of-3`** (`n = 3`, `t = 2`) in the create flow — redundant by default.
- **Allow `n === t`**, but when the user selects it, show a **clear, non-blocking warning badge** in
  the "Rule" step: no recovery margin; a lost device locks the funds; recommend `t`-of-`(t+1)`.
- Do **not** hard-block `n === t` (guardrail, not a wall).

## Consequences

- New vaults are recoverable-by-construction against a single lost device (the remaining quorum can
  still act), and are ready to benefit from social recovery once #58 lands.
- Power users can still choose `n === t` deliberately, having seen the risk.
- Copy must stay honest: the badge states the present consequence (funds locked), not a future
  promise. Pairs with the removal of the over-promising "social recovery brings it back" copy.

## Follow-ups

- #58 — wire RTS social recovery (and inheritance) into a live vault UI (the recovery flow the
  redundancy enables).
- Consider an explicit "I understand the risk" acknowledgment (not just a badge) if telemetry/feedback
  shows users still pick `n === t` unaware. (No telemetry today, by design.)
