# Payroll Redesign — accounting-system view

> **Status:** approved plan (2026-07-01). The payroll engine already exists and is solid
> (line-by-line + aggregate validation, single envelope, quorum). What is missing is giving
> the **workflow experience** the face of an **accounting document with a lifecycle**, not
> that of an import form. Apply it **gradually**, page by page.

## Cross-cutting principle (applies to every screen)

**"Every money movement is an accounting document, not a form."** Every page that touches
amounts must have:
1. **Entities, not raw strings.** A beneficiary/member is chosen from a registry (name),
   not a pasted `u1…` address.
2. **Period/accrual and document identity.** "Payroll · April/2026", with a number/ref.
3. **Explicit and visible states** (draft → checked → awaiting → paid → posted →
   reconciled), reusing the state machine (the `Draft` state already exists and is idle).
4. **Continuous validation**, not a separate "check" button.
5. **Totals always visible** (count, total, fee, balance after).
6. **Itemized ledger:** a payroll of N people becomes **N entries**, not 1 aggregate line.

## Payroll lifecycle (the target)

```
0. REGISTRY        beneficiaries exist (name, address, default memo)      [depends on 5-D]
        ↓
1. PREPARE         open a payroll for a PERIOD → EDITABLE table (import/pick/manual)
   (draft)         continuous per-line validation; live totals; SAVE draft (Draft state)
        ↓
2. CHECK           document review: total, warnings (public, balance, DUPLICATES)
        ↓
3. SUBMIT          becomes ONE document → "awaiting approval" (preparer≠approver segregation)
        ↓
4. PAY             quorum → sign (FROST) + broadcast → "paid" (txid)          [5-B.2]
        ↓
5. POST+RECONCILE  N ledger entries (date, beneficiary, amount, memo, period,
                   txid) → on-chain confirms → "reconciled" → detailed export
```

## Redesign of the `New Payroll` screen (target)

Replace the **CSV textarea + "Read/check" button** with an **editable document**:

- **Document header:** period (month/year), date, description; generated document number.
- **Editable table** (one line per beneficiary):
  - columns: beneficiary (from the registry when it exists; text+address until it does),
    amount, memo/payslip, inline warnings (public address, transparent memo, zero amount).
  - actions: **+ add line**, remove line, **import spreadsheet** (CSV) that *populates the
    table* (the CSV becomes an input shortcut, not the interface).
  - **continuous validation** per cell; an invalid line is flagged, it does not disappear.
- **Always-visible footer:** payment count · total · estimated fee · **balance after**.
- **Draft:** "Save draft" (persists as `Draft`); you can leave and come back.
- **Submit:** "Send for approval" (a clear step, separate from checking) → `Awaiting`.

## Itemized export (accounting trail)

`GET /api/ledger.csv` must emit **one entry per payment**:
- single payment → 1 line;
- payroll of N → **N lines** (one per beneficiary), sharing document/state/txid.
- proposed columns: `document,type,state,proposed_by,approvers,beneficiary,amount_zec,
  memo,destination,txid` (period/date come in once the document header exists).

## Roadmap fit

| Item | Where |
|---|---|
| Itemized export (N entries) | **accounting trail** — immediate slice, independent of 5-D |
| Editable table + period + draft (`Draft`) | **5-B.3** (payroll UI redesign) |
| Beneficiary as an entity (member registry) | **5-D** (real member identity) |
| Real N-output send | **5-B.2** (multi-output engine, `zcash_client_backend`) |
| On-chain reconciliation (sent→confirmed) | **accounting trail** / 5-C (sync + states) |

## Out of scope for now (incremental, honest)

Accounting categories/chart of accounts, per-beneficiary PDF receipts/payslips, and rich
spreadsheet (xlsx) import are left for later. The accounting face comes in **page by page**,
not all at once.
