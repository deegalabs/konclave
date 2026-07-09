# Konclave — Low-fidelity wireframes (Step 4)

> Structure and hierarchy, **without color/type** — the goal is to validate **ease** for
> Marina (non-technical) before the hi-fi model. Legend: **▸** primary action · **⚑**
> preview+confirmation · **⚠** error/state · **🔒** value under the banner · *(italic)* = runs
> hidden. Follows [UX_FUNDACAO.md](UX_FUNDACAO.md).

---

## 1. Intro (no vault yet)

```
┌──────────────────────────────────────────────────────────┐
│  ◧ KONCLAVE                                              │
│                                                          │
│      The vault that decides together.                    │  thesis in 1 line
│      Private outside, transparent inside.                │
│                                                          │
│   ┌───────────────────────┐   ┌───────────────────────┐  │
│   │  ▸ CREATE VAULT        │   │      JOIN A VAULT      │   │
│   │    start a group       │   │    I have an invite    │   │
│   └───────────────────────┘   └───────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```
Only two paths. Zero jargon. No "wallet/seed/key".

---

## 2. Ceremony — Create vault  (4-step stepper)

```
 [●───○───○───○]  1. Define   2. Invite   3. Create   4. Address
```

**Step 1 — Define**
```
┌───────────────────────────────────────────────┐
│  Vault name   [ Community treasury           ]│
│                                               │
│  How many people need to approve each         │  rule in human
│  payment?                                     │  language (not "threshold")
│      [ 2 ] of [ 3 ]  members   ◁ selector     │
│  ↳ "No one controls the money alone."         │  consequence microcopy
│                                    [ ▸ Next ] │
└───────────────────────────────────────────────┘
```

**Step 2 — Invite**
```
┌───────────────────────────────────────────────┐
│  Send this invite to each person:             │
│   [ konclave://invite/9f2… ]  [copy] [QR]     │
│                                               │
│  Members            Waiting for 2 of 3 to join│
│   ✓ You (owner)                               │
│   ✓ Bruno           joined                    │
│   ⋯ Carla           waiting…                  │
│                                    [ ▸ Next ] │  (enables when everyone joins)
└───────────────────────────────────────────────┘
```

**Step 3 — Create (the ceremony)**
```
┌───────────────────────────────────────────────┐
│  ⚠ Everyone must be in the app now.           │  warning BEFORE starting
│                                               │
│         [ ▸ Create vault now ]                │
│  ───────────────────────────────              │
│  Generating the vault keys…  (happens once)   │  progress, neutral language
│  ↳ "Your part of the key stays only on this   │  (runs the DKG via frostd;
│     device. It never leaves here."            │   share encrypted locally)
└───────────────────────────────────────────────┘
  ⚠ Member dropped → "Creation stopped because [name] left. Restart when everyone
     is ready."   ⚠ frostd down → offer QR/copy-paste.
```

**Step 4 — Address ready**
```
┌───────────────────────────────────────────────┐
│  ✓ Your vault is ready.                       │
│  Address to receive ZEC:                      │
│   [ u1vjgx…d406dr ]  [copy]  [QR]             │
│  ⚠ Receive only at an Orchard address.        │  guardrail (locked funds)
│                          [ ▸ Go to dashboard ]│
└───────────────────────────────────────────────┘
```

---

## 3. New payment

```
┌───────────────────────────────────────────────┐
│  ← Dashboard         New payment              │
│                                               │
│  To     [ Zcash address…                     ]│  ✓ valid? ✓ shielded?
│         ⚠ "This destination is public" (if transp.)│
│  Amount [ 0.5 ] ZEC        available: 🔒 2.41  │  ≤ available (balance−reserve−fee)
│  Memo   [ ref may                     ] 6/512 │  shielded only · counterparty
│         (receipt/payslip — only the recipient reads)│
│  ─────────────────────────────────────────    │
│  Est. fee 0.0001 ZEC · Balance after 🔒        │  ZIP 317, no surprise
│                                               │
│  ⚑ Preview: "You are about to PROPOSE 0.5 ZEC │  explicit confirmation
│     → zs1… needs 2 approvals (incl. yours)."  │
│                          [ ▸ Propose payment ]│  (not "send" — honest copy)
└───────────────────────────────────────────────┘
```
*(builds plan → PCZT → extracts what to sign; the proposer already counts as the 1st approval.)*

---

## 4. New payroll  (the second face — N destinations)

```
┌──────────────────────────────────────────────────────────┐
│  ← Dashboard   New payroll       [ ⭱ Import CSV ]        │
│                                                          │
│  #  Label      Address           Amount     Memo/payslip │
│  1  Ana        u1ana…           [0.5 ]     [april      ] │
│  2  Bruno      u1bruno…         [0.25]     [april      ] │
│  3  Carla      t1carla…  ⚠pub   [0.30]     [—          ] │  invalid line flagged
│  [ + add line ]  [ duplicate ]                           │
│  ──────────────────────────────────────────────────────  │
│  LIVE FOOTER:  8 payments · total 🔒 · est. fee 🔒 ·       │  grows w/ # destinations
│                balance after 🔒                           │
│                                                          │
│  ⚑ "May payroll — 8 payments. It needs 2 approvals."     │
│                                    [ ▸ Propose payroll ] │  (blocked if line invalid)
└──────────────────────────────────────────────────────────┘
```

**State — CSV import report**
```
┌───────────────────────────────────────────────┐
│  Imported: 7 lines accepted · 1 with error    │
│   ⚠ line 4: invalid amount ("oops")           │  reason + line number
│   [ Skip line 4 and continue ]  [ Review ]    │  partial import allowed
└───────────────────────────────────────────────┘
```
*(becomes ONE transaction with N outputs → ONE approval covers everything.)*

---

## 5. Proposal (detail) — approve / track

```
┌───────────────────────────────────────────────┐
│  ← Proposals          PENDING                 │
│  0.5000 ZEC → zs1q9f…7ka2                     │  (value under 🔒 until revealed)
│  memo "may advance"                           │
│  Proposed by Bruno                            │
│  Progress  [██──]  1 of 2  · already approved: Bruno │
│  Expires in 71h                               │
│                                               │
│  ↳ "By approving, you authorize this payment  │  responsibility microcopy
│     with your part of the key."               │
│        [ ▸ Approve ]     [ Refuse ]           │
│                                               │
│  (if I am the proposer: I see "waiting on the │  view changes by role (§6.7)
│   others" + [ Cancel ])                       │
└───────────────────────────────────────────────┘
  States: Awaiting · Ready/sending · Refused · Expired · Sent
  → when it hits 2 of 2, it goes to mainnet automatically. (FROST ceremony via frostd)
```

---

## 6. Sent (confirmation)

```
┌───────────────────────────────────────────────┐
│              ✓ Payment sent                   │
│         0.5000 ZEC → zs1q9f…7ka2              │
│                                               │
│   [ ▸ View on explorer ↗ ]  (on-chain proof)  │  verifiability
│   [ Back to dashboard ]                       │
│                                               │
│  The memo/payslip stays accessible only to    │
│  the recipient.                               │
└───────────────────────────────────────────────┘
```

---

## 7. Ledger / Accounting  (the accountant's request)

```
┌──────────────────────────────────────────────────────────┐
│  ← Dashboard  Ledger / Accounting        [ ⭳ Export ]    │  CSV/PDF, local
│                                                          │
│  Filters: [ month ▾ ] [ member ▾ ] [ type ▾ ]  [ 🔒 hide ]│  period/member/type
│  ─────────────────────────────────────────────────────── │
│  DATE    DESCRIPTION            WHO                AMOUNT│  ledger header
│  04/28   April payroll (8)      prop. Ana          −🔒    │
│                                 appr. Ana, Bruno   ↗     │  who proposed/approved
│  04/22   Donation received      —                  +🔒    │
│  04/15   Infrastructure pmt     prop. Bruno         −🔒   │
│                                 appr. Bruno, Carla  ↗    │
│  ─────────────────────────────────────────────────────── │
│  Period balance: 🔒     (all under the banner; revealing is a gesture)│
│                                                          │
│  ↳ "Internal transparency. The public blockchain reveals │
│     nothing." — hand this export to your accountant.     │
└──────────────────────────────────────────────────────────┘
```
*(read-only via UFVK — shows without being able to spend; export generated locally.)*

---

## What these wireframes prove (usability checklist)
- [x] Each screen has **one** obvious primary action (▸).
- [x] **Preview + confirmation** on anything that moves funds (⚑) — never 1 click fires ZEC.
- [x] **Zero visible crypto jargon**; security appears as trust microcopy.
- [x] The **Ledger + Export** covers "hand it to the accountant" (Accounting track).
- [x] Errors **direct** (⚠): they say what happened and what to do.
- [x] The **banner (🔒)** protects amounts by default across every surface.
- [x] The **payroll** accepts a spreadsheet (CSV) — the treasurer's real world.
