# Konclave Patterns — Index

> Phase: guidelines | Brand: konclave | Generated: 2026-07-08

Operational design-system artifacts for Konclave. These translate the audit + discover
findings into code-ready tokens, the agent contract, a visual guide, and the migration
map. Strategy: **EXTEND / CONSOLIDATE** — the owner locked the current dark theme + blue
accent `#57a6ff`; this is not a rebrand and not a recolor. It fixes the lying token
names, merges the three CSS files into one token layer, and deletes the stray oxblood
literals. Stack: Vite/React/TS in `ui/` with **plain CSS** (no Tailwind, no shadcn).

## Core

| File | What it is |
| --- | --- |
| [konclave.yml](./konclave.yml) | Single source of truth. The one truthful, role-based token set (surfaces, text, accent, success, warn, danger, silver, signature-device tokens), typography, shape, elevation, spacing, motion, patterns, constraints, effects, dark-mode note, local-first note. Intensity variance 2 / motion 2 / density 6. |
| [STYLE.md](./STYLE.md) | The agent contract. Brand-in-a-paragraph, the truthful token table, color-usage rules, typography, the signature devices (tarja / seal / stamp / identicon), surfaces + the one elevation rule, motion budget, never/always constraints (the anti-dark-SaaS ban), voice, the accessibility floor, and local-first constraints. |
| [guidelines.html](./guidelines.html) | Self-rendering dark visual guide using the brand's own tokens (Archivo + Spline Sans Mono). Color swatches, type scale, the tarja + seal devices, buttons/cards/inputs, voice never/always. Open in a browser. |

## Components

| File | What it covers |
| --- | --- |
| [components/token-mapping.md](./components/token-mapping.md) | The migration map: every OLD css var -> NEW name -> value -> files, across `lacre.css` + `redesign.css` (`.rd-*`) + `App.css`; the plan to merge the 3 CSS files into one `:root` token layer (plain CSS); the paste-ready `:root`; and the oxblood/purple literals to delete. |

## Apply phase (later build step — not done here)

The token bridge ([token-mapping.md](./components/token-mapping.md)) targets:

- `ui/src/lacre.css` — host the one `:root` token layer; consume it in the component
  classes (renamed vars).
- `ui/src/redesign.css` — delete the `.rd { --rd-*: … }` token block; keep `.rd-*`
  layout classes consuming the shared tokens; strip card shadows / hover-lift / glow /
  the `@keyframes rd-pulse` pulse / the metallic-bevel wordmark.
- `ui/src/App.css` — stop re-declaring surfaces; replace status literals with
  `--warn` / `--danger*`; delete the oxblood fallbacks (`#7E2A24`, `#37493C`).
- `ui/index.html` — remove the dead `/logo.png`; repoint the favicon at the blue mark
  (not the purple `#863bff` `favicon.svg`).

These are spec artifacts; applying them to `ui/src` is a separate build step.

## Related

- `../BRIEF.md` — the evolution brief.
- `../STATE.md` — phase state (strategy + identity skipped: keep current blue).
- `../audit/` — coherence-assessment.md, evolution-map.md, brand-inventory.md.
- `../discover/mood-board-direction.md` — language reference only; its oxblood "Wax &
  Graphite" pivot was **declined** by the owner.
