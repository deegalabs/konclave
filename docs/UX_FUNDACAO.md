# Konclave — UX Foundation (Steps 1–3)

> Persona, information architecture, and the 4 flows that matter. The cheap foundation that
> makes the hi-fi model come out right. Follows [ROTA_UX.md](ROTA_UX.md).

---

## Step 1 — Persona + tasks (jobs-to-be-done)

### Primary — Marina, the collective's treasurer
- **Who:** leads the operations of a DAO / Web3 community / small collective (or owns a
  business that manages a common fund). Looks after everyone's money.
- **Technical level:** **non-technical.** Lives on spreadsheets and a banking app. Does not
  understand — nor wants to understand — cryptography.
- **Goals:** pay contributors fairly and privately; **not be the single point of failure**;
  be able to **justify every expense** to the group and to the accountant; do it fast,
  without anyone's help.
- **Today's pains:** the options are bad — one person holds the key (risk), a shared key
  (insecure), transparent multisig (leaks everything on-chain). FROST in the terminal is
  impossible for her.
- **Win:** *"I paid the team, privately, with two approvals, and I hand my accountant a
  clean report."*

### Secondary — the co-signers (Bruno, Carla)
Members who hold a part of the key. They just want to **approve/refuse with one tap** when
something needs them. Low engagement, minimal effort. They do not run the day-to-day.

### Tertiary — Mr. Oliveira, the accountant
Closes the books and taxes. **Does not operate the app** (or has a **read-only view** — the
"UFVK Observer", roadmap). Needs **clean, exportable records**: dates, amounts, counterparty
(when known), **who approved**. Works in spreadsheets/PDF.

### Framing note (important)
The **main function** is the **collective vault with quorum-approved payments**.
**Single payment (1 destination)** and **payroll (N destinations)** are **two options of the
SAME mechanism** — payroll **is not the main face**, it is *one* way to pay. A single payment
is, at bottom, a "1-line payroll". The UI treats both as **parallel options** (never payroll
dominating).

### Prioritized tasks (in Marina's words)
1. "Set up a vault where **no one alone** controls the money."
2. "Have **a private address** to receive contributions."
3. "**Pay** a contributor/supplier with **the group's approval**, without leaking."
4. "Pay **everyone at once**, according to contribution (payroll/split), with **one**
   approval."
5. "On opening, see **how much there is** and **what is waiting for my approval**."
6. "Show the group and the accountant **what happened — who proposed and who approved — and
   export it**." ← elevated by the Accounting track.
7. "Do all of this **without dealing with cryptography**."

---

## Step 2 — Information architecture

### Navigation map (with the accounting lens)

```
                 ┌───────────────┐
                 │    INTRO       │  no vault yet
                 └───────┬───────┘
             Create vault │ Join a vault
                 ┌───────▼───────┐
                 │   CEREMONY     │  step-by-step DKG (feels like "forming a group")
                 └───────┬───────┘
                 ┌───────▼─────────────────────────────────────┐
                 │               DASHBOARD (home)               │◄────────┐
                 │  balance (banner) · what needs me · shortcuts         │
                 └──┬─────────┬──────────┬───────────┬──────────┬────────┘
          New payment    New payroll   Pending      LEDGER/         Members /
             │              │         proposals    ACCOUNTING       Trust
             └──────┬───────┘             │       │  (filter,       model
                    ▼                     ▼       │   export) ───────┘
             ┌─────────────┐      ┌──────────────┐   │
             │  PROPOSAL    │◄─────┤  (detail)    │   │
             │  approve /   │      └──────────────┘   ▼
             │  track       │                    (stretch) OBSERVER
             └──────┬───────┘                    read-only for the accountant
                    ▼
             ┌─────────────┐
             │    SENT      │  confirmation + explorer link
             └─────────────┘
```

### What each screen answers (and the primary action)

| Screen | Answers | Primary action |
|---|---|---|
| **Intro** | "Do I have a vault?" | Create / Join |
| **Ceremony** | "How is the vault born securely?" | Invite + create together |
| **Dashboard** | "How much is there? Does it need me? What happened?" | Approve the pending item |
| **New payment** | "How do I pay one destination?" | Propose |
| **New payroll** | "How do I pay several by contribution?" | Build/import → Propose |
| **Proposal (detail)** | "Do I authorize this expense?" | Approve / Refuse |
| **Sent** | "Did it really go out? How do I prove it?" | View on the explorer |
| **Ledger / Accounting** | "What happened? How do I hand it to the accountant?" | Filter → **Export** |
| **Members** | "Who is in control? Can I trust it?" | See the trust model |
| **Observer** (stretch) | (accountant) "What to record?" | Read-only / export |

**Key IA change:** history becomes the **Ledger/Accounting** — an accounting work surface
(filter by period/member/type, CSV/PDF export), not three decorative lines.

---

## Step 3 — The 4 flows that matter

> Format: human steps · *(what runs hidden)* · error branches.

### Flow 1 — Birth (create the vault)
The most delicate onboarding. Goal: feel like **"forming a group"**, not "running a
protocol".
1. Marina sets the **vault name** and the **rule** in human language: *"How many people
   need to approve each payment?"* → **2 of 3**. Microcopy: "No one controls it alone."
2. **Invite the members** (link/QR). The list fills as they join. *"Waiting for 2 of 3…"*
3. Everyone online → a single **"Create vault now"** button. *(runs the DKG via frostd; each
   one keeps their part locally, encrypted — never reconstituted.)* Screen: "Generating the
   keys… (happens once)".
4. **Address ready** (Orchard + UFVK). *"This is the address to receive. **Orchard only.**"*
- **Errors:** a member drops mid-way → "Creation stopped because [name] left. Restart when
  everyone is ready." · `frostd` down → QR/copy-paste fallback.

### Flow 2 — Pay with approval (the central loop)
1. Marina opens **New payment**: destination, amount, **optional memo** (private payslip).
   *Live validation:* is the address valid? enough balance (amount + fee)?
2. **Preview + confirmation:** "You are about to propose 0.5 ZEC → zs1… It needs 2 approvals
   (including yours)." Button **"Propose payment"** (not "send" — it does not send yet).
   *(builds the plan → PCZT → extracts what to sign; the proposer already counts as 1
   approval.)*
3. **The proposal travels.** Bruno sees it on the Dashboard, opens the **Proposal**, reads
   who proposed/destination/amount/memo, and **Approves** with one tap. Microcopy: "By
   approving, you authorize this with your part of the key." *(FROST ceremony via frostd;
   when it hits 2 of 3, it injects the signature.)*
4. **Sent** → confirmation + **explorer link** (on-chain proof). The Ledger records **who
   proposed and who approved**.
- **Errors/states:** a refusal that makes quorum unreachable → "Refused by [name]." ·
  expires → "Expired; re-propose." · network failure → "The proposal is still valid; try
  resending."

### Flow 3 — Payroll by contribution (the second face)
Same approval, entry of **N destinations**.
1. **Build the payroll:** editable table (label, address, amount, memo/payslip) **or import
   CSV** (the treasurer lives in a spreadsheet). *Live footer:* total + **estimated fee**
   (grows with the number of destinations, no surprise) + balance after.
2. **Import CSV** → report: accepted lines, lines with errors (reason + line number). Partial
   import allowed.
3. **Review:** "May payroll — 8 payments, total 4.2 ZEC. It needs 2 approvals."
4. **Propose → approve → sent** (identical to Flow 2), but **one transaction, N outputs, one
   approval** covers everything. Each person receives their amount and their encrypted
   payslip.

### Flow 4 — Close the books (the accountant's request)
What the Accounting track demands.
1. Marina opens the **Ledger**: full list, entries and exits.
2. **Filters** by period (month/quarter), member, type (payment/payroll/income).
3. Each exit shows **who proposed and who approved** + status + explorer link.
4. **Exports** (CSV/PDF) — generated **locally**, never sent to a server — and **hands it to
   the accountant**. *(read-only via UFVK; shows without being able to spend.)*
- **Privacy:** all of this is **internal transparency**; the public blockchain reveals
  nothing. Amounts under the **banner** by default; revealing is a deliberate gesture.

---

## What this locks for the hi-fi model
- The **primary action** of each screen (what the non-technical person does without
  thinking).
- The **Ledger/Accounting** as a first-class accounting surface (filter + export) — the
  answer to the Accounting track.
- Where **preview + confirmation** are mandatory (anything that moves funds).
- Where the **banner** and the **guidance/microcopy** carry trust without jargon.
