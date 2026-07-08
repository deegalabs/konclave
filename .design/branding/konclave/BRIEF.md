# Konclave — Brand Brief

> Phase: brief | Brand: konclave | Generated: 2026-07-08

---

## Essence

Konclave — "the vault that decides together." A local-first desktop app that puts a
usable human layer over the Zcash Foundation's FROST threshold-signature tools, so a
group can run a **private collective vault**: pay by quorum, and run a private payroll
(one Orchard transaction, N shielded outputs). *Private on the outside, transparent on
the inside.* The cryptography is the official Foundation tooling — Konclave is the human
layer, not the crypto.

## Target feeling

**Solid vault + discretion.** Trust through structure, not decoration. NOT cheerful
fintech, NOT hacker terminal, and explicitly **anti generic dark-SaaS** (floating glass
cards, glow-on-everything, gradient "web3" wordmarks). Privacy is expressed as a physical
**gesture** — the *tarja* (redaction bar, "SIGILOSO") that veils sensitive values until
revealed. Honest, calm, precise.

## Personas

- **Marina — community/DAO treasurer (primary).** Non-technical. Needs to move shared
  funds safely without a CLI or trusting one person. Must feel the vault is solid and that
  "no one moves the money alone." Reads Portuguese; the UI is bilingual (PT-BR default, EN).
- **Members (Alice/Bob/Carol).** Approve from their own device; their key share never
  leaves it. Want clarity on "what needs my approval" and honest state at all times.
- **The accountant (secondary).** Consumes the ledger / CSV — transparent inside, private
  outside.

## Competitive landscape

- **Zkool** (hhanh00) — power-user shielded-FROST wallet; our closest peer. We differ by
  purpose-built collective-vault + private-payroll workflows and non-technical UX.
- **lamb356 frost-ui** — web/WASM FROST UI. We are local-first desktop, not hosted web.
- **Zashi / Ywallet / Zingo** — single-user shielded wallets (no collective custody).
- **Gnosis Safe / MPC custody** — collective but transparent on-chain. Our line:
  "Safe, but the amounts are actually private."

## Current visual identity (to consolidate — see audit)

Dark theme shipped ("silver + blue on slate"), but fragmented: three color stories, two
parallel CSS systems (lacre.css global + redesign.css `.rd`-scoped) + App.css, mis-named
tokens (`--seal` is now blue `#57a6ff` not oxblood; `--pine` is mint), stray oxblood
literals, a purple favicon (`#863bff`) pointing at a deleted logo. Typography (Archivo +
Spline Sans Mono) is the one fully coherent layer.

## Goal of this evolution

Do NOT rebrand. **Finish the current one:** one truthful, dark-first token set with correct
names; merge the CSS systems; a `STYLE.md` agent contract (à la the sibling shieldpay's
`.design/patterns/STYLE.md`); resolve the mark/favicon; keep the tarja + seal + mono +
Archivo. Prior analysis: `temp/audit-brand.md`, `temp/audit-ux-critique.md`,
`temp/audit-accessibility.md`. Structure reference: `/home/daniel/development/deegalabs/shieldpay/.design/`.

## Constraints

Local-first / no telemetry (fonts self-hosted, no external CDN). Accessibility as a floor
(the tarja and nav must be keyboard-operable — currently not). Stack: Vite/React/TS in `ui/`,
plain CSS (no Tailwind/shadcn). Bilingual UI via the existing i18n (PT-BR default + EN).
