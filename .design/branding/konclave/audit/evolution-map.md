# Evolution Map — Konclave

> Phase: audit | Brand: konclave | Generated: 2026-07-08

---

The primary audit deliverable: element-by-element **PRESERVE / EVOLVE / REPLACE** decisions
with rationale tied to personas and to the stated goal — *consolidate the existing dark
design into one coherent token system + STYLE.md; do NOT rebrand*. Downstream phases
(strategy → identity → guidelines) treat this table as the contract for what changes.

Legend — **PRESERVE**: keep as-is (may be renamed but not redesigned). **EVOLVE**: keep the
intent, change the execution. **REPLACE**: remove and substitute.

## The map

| # | Element | Current state | Decision | Rationale (persona / goal) |
|---|---|---|---|---|
| 1 | **Dark "solid vault" aesthetic** | Layered slate, dark-first | **PRESERVE** | The whole brief is "finish the dark one." Marina must feel the vault is solid; dark = discretion. Foundation of everything. |
| 2 | **Tarja / redaction gesture** | `"SIGILOSO"` bar, collapse-left | **PRESERVE** (amplify) | Highest equity; the one ownable device (equity, market-fit). Make it the brand's face. Must survive being made keyboard-operable. |
| 3 | **Mono-for-money rule** | Every figure in Spline Sans Mono | **PRESERVE** | Reads as ledger/instrument; serves the accountant. Inviolable rule in STYLE.md. |
| 4 | **Archivo + Spline Sans Mono** | Self-hosted, 5+3 weights | **PRESERVE** | The one fully-coherent layer; not-fintech, not-AI-serif. Already local-first compliant. |
| 5 | **Self-hosted fonts** (`@fontsource`) | `main.tsx:5-12` | **PRESERVE** | Prior audit's remote `@import` concern is already fixed. Local-first floor is met here. |
| 6 | **Deterministic identicons** | Steel-blue symmetric grid | **PRESERVE** | Local-first faces for members; quiet, on-brand. Palette should follow the accent/silver decision. |
| 7 | **Honest active voice** | "Propor → Aprovar → Enviado" | **PRESERVE** | Best expression of §7; serves all personas. (Jargon leaks are a UX-critique fix, not a brand change.) |
| 8 | **The stamp device** | Rotated `-4deg` state tag | **PRESERVE** | Consistent, on-brand instrument detail. Recolor via new success/danger tokens. |
| 9 | **Token names** (`--seal`=blue, `--pine`=mint) | Names lie about values | **EVOLVE** | Rename to role: `--accent`, `--success`, `--surface-1/2`, `--text`/`--text-muted`, `--silver`. Ship alias→sweep→delete. Truthful tokens = maintainable system. |
| 10 | **Two CSS systems** (`lacre.css` + `redesign.css`) | `.rd` on Intro/Vaults only; lacre on the rest | **EVOLVE** (merge) | Fold `--rd-*` + the loose hexes into the one token set; port Intro/Vaults so "entering a vault" stops feeling like a different app. One vocabulary. |
| 11 | **`App.css` re-declared surfaces** | Card recipes duplicated on top of lacre | **EVOLVE** | Collapse into one tokenized card recipe (`--surface-2`, `--radius`, `--shadow-card`). |
| 12 | **Semantic colors** (warn/danger) | Hardcoded `#ffcf87`/`#ff6b6b` literals | **EVOLVE** | Promote to `--warn` / `--danger` (+ soft tints) tokens. One place for status color. |
| 13 | **Elevation / floating glass** | `0 22px 44px` shadow + hover-lift + glow | **EVOLVE** | Decide ONE budget. Brand-aligned: flatten toward hairline surfaces; reserve shadow for overlays only. Pulls away from the banned dark-SaaS look. |
| 14 | **Glow / pulse budget** | Glow on mark/seal/emblem/lockup; infinite green pulse | **EVOLVE** | Cap the budget: glow only on the mark/seal (or none); drop the infinite pulse (also a reduced-motion fail). Anti-cliché. |
| 15 | **The accent color `#57a6ff`** | Default crypto-dashboard blue | **EVOLVE** | Reconsider toward a cooler/more reserved accent used *sparingly* (interactive + quorum only), with silver as the true secondary. Moves from "crypto app" to "vault" (market-fit). |
| 16 | **The `Mark()` glyph** | Ambiguous spokes+keyhole, glow | **EVOLVE** (real design) | One deliberate concept (keyhole / wax seal / closing ring / interlocking members), one component, legible at 16px, no favicon-size glow. The one place real design is warranted. |
| 17 | **The quorum `Seal()` medallion** | Compass-rose rings, reads as gauge | **EVOLVE** | Bring back a seal read (matte, embossed, single accent, minimal glow) OR rename honestly to "quorum medallion." Make it a visible sibling of the mark. |
| 18 | **Metallic-bevel wordmark** (`.rd-brand`) | `background-clip:text` chrome | **REPLACE** | Web3 chrome at odds with "carimbo institucional." Use the plain tracked-mono `KONCLAVE` wordmark already in the letterhead. |
| 19 | **Purple favicon** (`favicon.svg`) | `#863bff` origami/arrow + glows | **REPLACE** | Off-palette, off-concept, negative equity. Derive the favicon from the chosen mark (#16) so tab/header/lockup are one object. |
| 20 | **Dangling `/logo.png`** | `index.html:6` → missing file | **REPLACE** | Remove the dead reference; point at the derived favicon. First-impression correctness. |
| 21 | **Oxblood literals** | `#7E2A24`/`#37493C`/`rgba(126,42,36,.35)` | **REPLACE** | Dead light-theme remnants; risk of the old palette flashing on var-load failure. Delete; use `color-mix` on the accent for the link underline. |
| 22 | **Two-vocabulary structure** (`.rd` scope) | Parallel `--rd-*` dialect | **REPLACE** | The structural cause of drift. One `:root` token set; `.rd` layout classes (if kept) must consume shared tokens, not private hex. |
| 23 | **Stale design docs / duplicate css** | (if any survive the `rosto→ui` rename) | **REPLACE** | Replace with a single `STYLE.md` agent contract (à la shieldpay's `patterns/STYLE.md`) as the only source of truth. |

## Structural additions the map implies (not "elements" but deliverables)

- **One `:root` semantic token set**, dark-first, structured so a future `[data-theme=light]`
  needs no renames. Truthful role-based names (#9).
- **`STYLE.md` agent contract**: brand-in-a-paragraph, the token table, color-usage rules
  (accent = interactive + quorum only; success earned; silver as secondary), the type scale,
  the signature devices (tarja/seal/mark/identicon), one elevation + one motion budget, voice
  rules, the accessibility floor (visible focus, keyboard for the tarja), local-first
  constraints, and an anti-cliché don'ts list.

## Preserve / Evolve / Replace split

Measured across the 23 catalogued elements (and weighted by brand surface — the preserved
items are the load-bearing ones: aesthetic, tarja, type, mono, voice):

- **PRESERVE — ~48%** (8 elements: the dark aesthetic, tarja, mono rule, type pairing,
  self-hosted fonts, identicons, voice, stamp — the entire load-bearing identity).
- **EVOLVE — ~35%** (9 elements: token names, CSS merge, App.css surfaces, semantic-color
  tokens, elevation, glow budget, accent, mark, seal — same intent, better execution).
- **REPLACE — ~17%** (6 elements: metallic wordmark, purple favicon, dangling logo.png,
  oxblood literals, the two-vocabulary structure, stale docs — pure liabilities).

Read: **this is a consolidation, not a rebrand.** Roughly half the brand is preserved
outright, a third is refined in place, and only the ~17% that is genuinely broken or off-
concept is removed. The one element inside "evolve" that needs real design (not just
consolidation) is the mark/favicon/seal family (#16–17, 19).

---

## Related

- brand-inventory.md — the catalog behind each row
- equity-analysis.md — the keep-vs-inertia reasoning for PRESERVE decisions
- coherence-assessment.md — the disconnects that drive the EVOLVE/REPLACE decisions
- market-fit.md — the accent + elevation rationale (rows 13-15)
