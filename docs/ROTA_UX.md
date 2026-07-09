# Konclave — UX Route (before the hi-fi model)

> Phase 4 (UI) plan. The path that leads from ideas to high-fidelity screens **usable by a
> non-technical business owner**, not by a developer. Companion to
> [ui/design/DESIGN.md](../ui/design/DESIGN.md) and [ROADMAP.md](ROADMAP.md).

## Anchor principle

> **All the cryptography swept under the rug; on top, a financial instrument that the owner
> of a collective uses alone and hands to their accountant.** Security and privacy become
> *comfort*, not *friction*.

The user never sees FROST/DKG/PCZT/sighash. They see **vault, members, approve, pay, close
the books, export**.

## Product context (what became clear)

A **DAO/collective that manages common money** and **pays its people according to
contribution**. Operated by a **non-technical treasurer**, who needs to **account to the
group and to the accountant** — without leaking anything on-chain. The **Accounting track
carries equal weight** to FROST: accounting and export are first-class citizens.

## The 7 steps

| # | Step | Output |
|---|---|---|
| 1 | **Persona + tasks (JTBD)** | 1 persona page + prioritized tasks |
| 2 | **Information architecture** | IA map + what each screen answers |
| 3 | **The 4 flows that matter** | Step-by-step journeys (states/errors) |
| 4 | **Low-fidelity wireframes** | Structural schematics of the core screens |
| 5 | **Copy / content** | Voice guide + strings for the core screens |
| 6 | **Hi-fi model in "Lacre"** | Core screens in high fidelity |
| 7 | **Real frontend (Next.js) + integration** | UI wired to the Orchestrator (Phase 5) |

Steps 1–3 are in [UX_FUNDACAO.md](UX_FUNDACAO.md).

## Calibrating "Lacre" (this route's decision)

We keep **Lacre** (a document/ledger feel suits accounting), but **calibrated to a usable
tool**, not a ceremonial piece: density and clarity where it counts (the
**Ledger/Accounting**), guided and warm in the copy, always under the **banner** model
(internal transparency, external opacity).

⚠️ **Watched risk:** Lacre is serious/austere — good for money, but it **must not
intimidate** the non-technical owner. Cure = **guidance + plain language + preview
everywhere**, not swapping the aesthetic.

## The tension that is the differentiator

An accounting app **shows a number for everything**; Konclave **hides** it (shielded). This
is not a conflict — it is the unique positioning: *"accounting the group trusts on the
inside, invisible on the outside"*. From the bookkeeping world we take **clarity, the
ledger, and the export**; **not** the "expose everything" nor the financial-suite scope (no
invoices/accounts payable — we are **shielded treasury with accounting**).

## Execution order

Steps **1–3 together** (cheap foundation) → **4 (wireframes)** to validate ease → **6
(hi-fi)** only then. Step 5 (copy) permeates 4 and 6.
