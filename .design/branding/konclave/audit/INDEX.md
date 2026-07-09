# Audit INDEX — Konclave

> Phase: audit | Brand: konclave | Generated: 2026-07-08

---

Phase-0 brand audit for **Konclave** — a local-first collective-vault desktop app over the
Zcash Foundation's FROST tooling. Scope: **evolve/consolidate** the existing dark design
(NOT a new brand) into one coherent token system + `STYLE.md`. Downstream phases (research →
strategy → identity → guidelines) consume these five chunks; `evolution-map.md` is the
primary deliverable.

Source of truth read for this audit: `.design/branding/konclave/BRIEF.md`, `config.json`;
prior analysis `temp/audit-brand.md`, `temp/audit-ux-critique.md`, `temp/audit-accessibility.md`;
and the live code in `ui/` (`lacre.css`, `redesign.css`, `App.css`, `components.tsx`,
`avatar.tsx`, `main.tsx`, `index.html`, `public/favicon.svg`). Note: prior analysis
referenced the old `rosto/` paths — the folder is now `ui/`, screens are English-named, and
fonts are already self-hosted via `@fontsource` (the old remote-`@import` finding is
resolved).

## Chunks

| # | Chunk | What it answers | Key output |
|---|---|---|---|
| 1 | [brand-inventory.md](brand-inventory.md) | What exists? Full catalog: mark, colors (exact hex), type, devices, voice, positioning | The raw material for all other chunks |
| 2 | [coherence-assessment.md](coherence-assessment.md) | Is it coherent? 3 axes scored 1-5; the 6 concrete disconnects | Strategy 4/5 · Strategy↔Visual 3/5 · Internal 2/5 |
| 3 | [market-fit.md](market-fit.md) | How does it sit vs Zkool / frost-ui / Zashi / Gnosis Safe? | Differentiation is conceptual + typographic, not chromatic; behind on anti-dark-SaaS |
| 4 | [equity-analysis.md](equity-analysis.md) | What's worth keeping (equity vs inertia)? | Tarja + mono + type = genuine equity; blue/mark/glow = inertia |
| 5 | [evolution-map.md](evolution-map.md) | **PRIMARY** — per-element PRESERVE/EVOLVE/REPLACE | 23-element decision table + split |

## Headline findings

- The dark instinct is right and **typography is the one fully coherent, already-compliant
  layer**. The failure is **internal consistency (2/5)**: three color stories, two CSS
  vocabularies, token names that lie (`--seal`=blue, `--pine`=mint), oxblood literals, a
  purple favicon, and a dangling `logo.png`.
- Highest-equity, most ownable asset: **the tarja (redaction) gesture** — amplify it.
  Differentiation is conceptual + typographic; the accent `#57a6ff` reads as generic
  crypto-dashboard and drags the brand toward the dark-SaaS look it means to avoid.
- The one element warranting real design (not just consolidation): the **mark / favicon /
  seal** family — currently three unrelated objects.

## Preserve / Evolve / Replace split

- **PRESERVE ~48%** — dark aesthetic, tarja, mono-for-money, Archivo+Spline, self-hosted
  fonts, identicons, voice, stamp (the load-bearing identity).
- **EVOLVE ~35%** — token names, CSS merge, App.css surfaces, semantic-color tokens,
  elevation, glow budget, accent, mark, seal.
- **REPLACE ~17%** — metallic wordmark, purple favicon, dangling logo.png, oxblood literals,
  the two-vocabulary structure, stale docs.

This is a **consolidation, not a rebrand**: half preserved outright, a third refined in
place, only the broken ~17% removed.

---

## Related

- ../BRIEF.md — aspirational direction, personas, competitors
- ../config.json — evolution scope (preserve/evolve/replace intent)
