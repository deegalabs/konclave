# ADR-0009: Vault IA restructure (everything in-vault, one activity place, honest roles)

- **Status:** proposed
- **Date:** 2026-08-20
- **Context:**

  The in-vault navigation grew one rail item per backend concept, so it now asks the user to tell
  apart things that are, to them, one thing. A `gsp-project-critic` pass (grounded in file:line, see
  issue #128) found seven problems, four of them high-impact:

  1. **The rail mixes places, actions, and the same object three times.** A **payroll is a
     proposal** (`NewPayroll` produces a proposal); **Proposals** (`/proposals`) and **Ledger**
     (`/ledger`) are two filtered views of the same proposal collection; **Ceremonies**
     (`/ceremonies`) is a third read-only view of the same lifecycle. Meanwhile a single **Payment**
     (`/pay`) has no rail entry at all. Users cannot predict which screen holds a given item.
  2. **"Signers" and the signing step eject the user out to `/net`.** Creating a vault
     (`Members.tsx:166 nav('/net')`) and signing an approved proposal (`Proposal.tsx nav('/net')`)
     throw the user out of the in-vault shell, contradicting "do everything inside the vault" and
     §7 "states always visible". `NetVault` already has an **embedded** mode that is simply not
     mounted inside `<Layout>`.
  3. **Presence is untruthful.** The Dashboard rendered the seat count next to a "live" pill, so
     "2 members" + "live" read as "2 members online" when only the connection is live. (Partly
     fixed: the pill now reads "connected", K7 / #122. True per-member presence still pending.)
  4. **The proposer could vote as any member.** (Fixed: K4 / #119; a device now casts only its own
     seat.)

  Plus: no breadcrumb/back on drill-ins (K12, shipped), "Next step" connectors that point *up* the
  rail against the task flow, and no members peek / no who-signs-vs-who-approves distinction.

  This ADR records the target information architecture so the larger changes (K10, K11, K13, K14)
  are built as one coherent, reviewed design rather than piecemeal. It does **not** change the FROST
  ceremony, the state machine, or any money-path logic; it changes *where* the same operations live
  and *how* they are grouped.

- **Decision:**

  **1. One rail, grouped by intent (9 items → 7).**

  ```
  - Overview        /dashboard
  - Add funds       /receive
  ACTIONS
     Pay            /pay        (surface the existing route as a rail item)
     Payroll        /payroll
  ACTIVITY
     Activity       /ledger     (tabs: Needs you · Open · Settled · Evidence)
  PEOPLE
     Signers        /members
     Beneficiaries  /people
  - Settings        /settings   (also links /net as read-only "network / diagnostics")
  ```

  **Merge `Proposals` + `Ledger` + `Ceremonies` into one `Activity` destination** with in-page tabs
  (reuse the chip filters already in `Ledger`): *Needs you* and *Open* absorb `Proposals`' awaiting/
  ready groups; *Settled* is the ledger; *Evidence* is the ceremony trail. Keep **Pay** and
  **Payroll** as the two compose actions, grouped visually apart from the read destinations (the
  shieldpay pattern). This removes two rail items and the "which list holds it?" ambiguity.

  **2. The ceremony and signing move in-app (retire the `/net` redirect).** Mount the existing
  `<NetVault embedded />` under `<Layout>` at in-vault routes (`/create`, and a `/sign` reached from
  a ready proposal), keeping the rail, the live pill, and the quorum seal visible. Change the
  `nav('/net')` call sites (`Proposal.tsx`, `Members.tsx`) to these in-vault routes. Bare `/net`
  stays as a **reference / diagnostics** page linked from Settings, never a redirect target. This is
  the UI half of the Dashboard-signing convergence (#49); the **broadcast cutover stays money-gated
  behind a live 2-device dry-run** (#49 Stage 4) and is not flipped by this ADR.

  **3. Breadcrumb/back on drill-ins.** `PageHeader` carries an optional `back` slot (shipped, K12 /
  #133); applied to the proposal detail and, next, the compose screens.

  **4. Identity is self-served; the quorum is for money.** Each member edits **their own** name
  freely (a local/public label, no quorum). Only fund-moving actions go through a proposal. Names
  stay public coordination data on the blind helper; a device may set only its own seat's name in
  the live path (mirrors the K4 rule for votes).

  **5. Members peek with honest roles.** A hover/focus **popover** off the "N members" affordance
  lists the roster (creator and "you" marked). The **signs vs approves** split is shown only where
  it is real: it requires a per-member role in the governance model (`gov === 'quorum'`), which is
  not modeled per-member today; until it is, the popover shows the roster and the quorum, not an
  invented split. Wiring the split is tracked with the governance work.

- **Consequences:**
  - Two fewer rail items; one money-history place instead of three; no out-of-app ejections; a back
    affordance on every drill-in; an honest members peek.
  - Sequencing: K12 (done) → K14 members popover (contained) → K10 Activity merge (non-money, larger
    refactor of `Layout` + a tabbed screen) → K11 in-vault ceremony mount (UI non-money; broadcast
    stays gated by #49 Stage 4) → K13 self name-edit. K5/#120 (engine bump) and #86 (migration) are
    independent money-path tracks.
  - No change to the state machine, ZIP-317 validation, the FROST ceremony, or the blind-relay /
    blind-helper invariants (ADR-0006, ADR-0007). Signing security (H1/H2) is unchanged by moving
    *where* the signing UI renders.

- **Refs:** #128 (epic + full critique), #49 (Dashboard signing / retire /net), #89 (landing
  redesign, separate), #119 (K4, done), #122 (K7 presence), #133 (K12, done).
