# Brand Inventory — Konclave

> Phase: audit | Brand: konclave | Generated: 2026-07-08

---

Full catalog of the shipped dark identity as it exists in `ui/` at branch
`polish/foundation`. Everything here is observed in code, not aspirational. This is the
raw material the coherence, equity, and evolution chunks operate on.

## Positioning (the yardstick)

"The vault that decides together." A local-first desktop app that puts a human layer over
the Zcash Foundation's FROST tooling so a group runs a **private collective vault** — pay
by quorum, private payroll. Target feeling: **solid vault + discretion**; trust through
structure, not decoration. Explicitly **anti** cheerful fintech, anti hacker terminal, anti
generic dark-SaaS (floating glass, glow-on-everything, gradient web3 wordmarks). Privacy is
a physical gesture — the *tarja*. Governing UX law (CLAUDE.md §7): "hide the cryptography,
expose the trust" — user sees vault/members/approval, never FROST/nonce/SIGHASH.

## Mark / emblem

- **`Mark()`** (`ui/src/components.tsx:20`) — the only wordmark glyph in the header. 12
  silver spokes (`#c6cfd9`) radiating around a small ring, with a blue "keyhole" (a
  `#57a6ff` circle + a `#57a6ff` triangle). Carries an inline blue glow
  `drop-shadow(0 0 4px rgba(87,166,255,.35))`. Rendered at 22px in the letterhead. Intended
  read: "radial key / keyhole." Actual read at header size: a small sun / asterisk /
  compass.
- **`favicon.svg`** (`ui/public/favicon.svg`) — a completely unrelated **purple origami /
  arrow** mark, `#863bff` + `#7e14ff` + `#47bfff` with display-p3 fills and ~15 gaussian-blur
  glow ellipses. This is the browser-tab icon and matches nothing else in the system.
- **`/logo.png`** — referenced first in `ui/index.html:6` but the file does not exist in
  `ui/public/`; the tab icon therefore falls through to the purple `favicon.svg`.
- No single canonical mark exists. Header glyph, favicon, and the (missing) PNG lockup are
  three different objects.

## Color (exact hex, as shipped)

Three overlapping color stories ship at once:

**A. lacre.css `:root` — the primary dark token set** (`ui/src/lacre.css:4-11`)

| Token | Hex | Real role in the app |
|---|---|---|
| `--paper` | `#171c22` | base panel / sheet |
| `--paper-2` | `#1e252d` | insets, fields, cards |
| `--line` | `#333d47` | hairlines / dividers |
| `--line-2` | `#28313a` | card borders |
| `--ink` | `#dfe6ee` | primary text |
| `--muted` | `#8a95a3` | secondary text |
| `--seal` | `#57a6ff` | **blue** — links, focus, primary btn, quorum, stamps |
| `--seal-ink` | `#3f86e0` | pressed/hover of the blue |
| `--pine` | `#57d08a` | **mint** — received / confirmed / live status |
| `--silver` | `#c6cfd9` | metallic secondary, mark |

Page background is a layered slate radial gradient: `rgba(87,166,255,.10)` bloom over
`#2b333c → #1b2127 → #12161a`, plus a 5%-opacity dot texture (`rgba(200,220,245,.7)`).

**B. redesign.css `.rd` — a parallel vocabulary** (`ui/src/redesign.css:5-10`), scoped to
`.rd` and used by **only two screens** (`Intro.tsx`, `Vaults.tsx`):
`--rd-text:#dde5ee`, `--rd-muted:#8a95a3`, `--rd-accent:#57a6ff`, `--rd-silver:#c6cfd9`,
`--rd-line:rgba(180,205,235,.10)`. Beyond the tokens it hardcodes ~25 raw hexes:
`#aeb8c4 #d6dee7 #6fa8de #f2f6fb #a7b2c0 #dbe3ec #86bdf2 #f0f4fa #97a2af #737d8a #7fb4ec
#08121e #828d9a #9aa5b2 #a9cdf5 #e6edf5 #06121f #1a2026`, plus a metallic wordmark gradient
`#f6f9fc → #c2ccd7 → #8b96a3 → #d6dee7` and a green pulse `#57d08a`.

**C. Stale oxblood + purple literals** — remnants of the old light "Lacre" theme and the
abandoned logo:
- `ui/src/App.css:28,32` — `var(--seal, #7E2A24)` (oxblood fallback under a token now blue).
- `ui/src/App.css:13` — `var(--pine, #37493C)` (archival-green fallback).
- `ui/src/lacre.css:93` — link underline `rgba(126,42,36,.35)` (oxblood at 35% under a blue
  link → a muddy hairline).
- `favicon.svg` purple family (see Mark).

**Semantic colors, hardcoded (no tokens)** in App.css: warn `#ffcf87`/`#ffe0a3`, danger
`#ff6b6b`/`#ff8f8f`/`#ffb4b4`/`#ff9d9d`, accent-tint fills `rgba(87,166,255,.06–.1)`.

## Typography — the one coherent layer

- **Archivo** (weights 400/500/600/700/800) — display + UI. Headings uppercase, tracked,
  `letter-spacing:-.02em` on the big `.h1`.
- **Spline Sans Mono** (400/500/600) — money, addresses, txids, micro-labels, table cells.
  The "livro-razão / instrument" precision. Rule in practice: every number is mono.
- **Self-hosted** via `@fontsource` in `ui/src/main.tsx:5-12` — the prior audit's remote
  Google-Fonts `@import` violation is **resolved**. Local-first compliant.

## Signature devices

- **The tarja (redaction bar)** — `Secret` (`components.tsx:52`) + `.secret .bar`
  (`lacre.css:66`). A `#0c1014` bar with a fine pinstripe and a `"SIGILOSO"` mono label,
  collapsing to the left on reveal (`App.css:115`, ~280ms cubic-bezier). The single
  strongest, most ownable brand element. Caveat: it is a mouse-only `<span onClick>` — no
  role, no keyboard, no ARIA.
- **The quorum seal / medallion** — `Seal` (`components.tsx:78`). Concentric rings
  (`#57a6ff` at r45/r39, `#c6cfd9` dashed at r34) + an `#8ba7c9` compass-rose / guilloché,
  with `t/n` centered, under a blue glow. Reads as a compass gauge / crypto badge, not a wax
  seal — despite "cera de lacre" being the etymology of the product name.
- **Deterministic identicons** — `Identicon` (`ui/src/avatar.tsx`). FNV-hash → symmetric 5×3
  mirrored grid, steel-blue `hsl(198–250 …)`. A member reads as a face, not a hex key. Fully
  local (no gravatar fetch). Quiet and on-brand.
- **The stamp** — `.stamp` (`lacre.css:82`): a rotated `-4deg` bordered mono tag used for
  proposal states (sent/confirmed → `--pine`; rejected/expired/cancelled → `#ff6b6b`).
- **The stepper** — `.steps` pips (`lacre.css:96`) for the ceremony flow.

## Voice / messaging

Honest, active, domain-translated PT-BR (bilingual via i18n, PT-BR default). "Propor
pagamento" → "Aprovar" → "Enviado"; "cofre", "quem cuida deste cofre", "ninguém move o
dinheiro sozinho". Errors are plain and actionable (`humanError()`). This is the best
expression of §7 in the product. Leaks to fix live in the UX critique (DKG/FROST/sighash
surfacing), not here.

## Structural facts (for downstream phases)

- **Two CSS systems**: `lacre.css` (global tokens, imported in `main.tsx:13`) governs 9 of
  11 screens; `redesign.css` (`.rd`, raw hex) governs only `Intro.tsx` + `Vaults.tsx`;
  `App.css` layers screen layout on top of lacre and re-declares card surfaces + carries the
  oxblood fallbacks.
- **Elevation is ambiguous**: floating cards with `0 22px 44px` shadows + hover-lift
  (`translateY(-4px)`) + hover glow in `.rd`, vs mostly-flat hairline surfaces in lacre. No
  single elevation rule.

---

## Related

- coherence-assessment.md — how these pieces contradict each other, scored
- equity-analysis.md — which of these to keep vs discard
- evolution-map.md — the per-element PRESERVE/EVOLVE/REPLACE decision
