# Mood-Board Direction — Konclave

> Phase: discover | Brand: konclave | Generated: 2026-07-08
> The key deliverable. A specific, opinionated visual direction that lands "solid vault +
> discretion" and moves the accent off generic crypto-blue. Feeds identity + guidelines.
> This is an EVOLVE: it preserves dark + tarja + seal + Archivo + Spline Sans Mono, and
> re-stories the palette. All hexes are proposals, not final tokens.

---

## The one-sentence direction

**A sealed treasury dossier, rendered as an instrument:** near-black graphite ground, warm
paper-white text, silver as the working metal, and a single deep **sealing-wax oxblood** as
the *only* chromatic signal — spent on the seal, the tarja, and quorum, nowhere else.
Achromatic by default; color is rare and always means something.

This is the "Lacre" (sealing wax) concept finally made literal, and it is the deliberate
opposite of crypto-blue-dashboard.

## Palette direction — RECOMMENDED: "Wax & Graphite" (achromatic + one signal)

Philosophy borrowed from instrument-dark (see `trend-analysis.md` #3): the interface is
built almost entirely from graphite + silver + paper; the **oxblood is a signal, not a
theme.** This solves the accent problem *and* the "one accent, many collisions" problem —
because the accent is used sparingly, the semantic reds/greens have room to mean something.

| Role | Hex | Notes |
|---|---|---|
| `--bg` (surface-0, app) | `#101012` | Near-black **neutral graphite** — NOT blue-cast (#0A0A0F drifts blue). |
| `--surface-1` (panels) | `#17171A` | First layer up. |
| `--surface-2` (raised) | `#1E1E22` | Cards/rows; the deepest elevation UI needs. |
| `--border` (hairline) | `#2C2C31` | Separation by line, not shadow. |
| `--text` | `#E8E4DA` | **Warm paper-white** (archival), not clinical #FAFAFA. |
| `--text-muted` | `#9A968C` | Warm grey; metadata, secondary labels. |
| `--silver` (secondary) | `#C3C5CB` | The **workhorse metal**: numerals, key labels, mono-for-money, mark strokes. Promoted to true secondary per market-fit. |
| `--accent` (sealing wax) | `#A5352B` | THE signal — quorum, interactive focus, seal fill, tarja ink option, links. One per screen. |
| `--accent-hover` | `#C2564A` | Lighter wax for hover/link text (contrast on dark). |
| `--seal-deep` | `#7E2A24` | Deep wax for the embossed seal medallion (the original oxblood, reclaimed on-concept). |
| `--success` | `#5E8C6A` | **Muted pine**, not neon — quorum-met / sent. Earned, quiet. |
| `--warn` | `#C79A3E` | Brass/amber — address warnings, expiry soon. |
| `--danger` | `#E5533D` | **Bright** red-orange — destructive/error only. Distinct from oxblood by luminance + chroma (wax is dark/brown, danger is bright/pure), so "danger" keeps its signal. |

Why this reads as vault not crypto: the *dominant* impression is graphite + silver + paper
(a ledger, a safe, a document), with red appearing only where trust is being transacted.
Crypto-blue is gone entirely. Amber and green are demoted to semantic-only. The palette has
a **story** (wax on paper) rather than a swatch.

### Alternative accent stories (for identity phase to weigh)

- **B — "Archival Brass."** Same graphite/silver/paper base, accent = brass/gilt `#C1954E`
  (gilt seal, official ledger). Fully escapes both crypto-blue and red-danger collision;
  warmest/most institutional. *Cost:* brass is a known dark-UI amber default (less ownable
  than wax), and it competes with `--warn`. Consider brass as a *secondary metallic* detail
  on the seal rim rather than the primary accent.
- **C — "Vault Patina."** Accent = oxidized-bronze teal `#3E7C71` (aged metal / vault-door
  patina). Cool but decisively *not* azure crypto-blue. *Cost:* green-family collides with
  `--success` semantics; needs careful separation. Weakest tie to the "Lacre" concept.

Recommendation: **A (Wax & Graphite).** It is the most ownable, ties to the product's own
name, and gives the tarja and seal a color they *earn*. Keep B's brass as an optional
secondary metallic if the seal needs two tones.

## Typography direction (PRESERVE — the coherent layer)

- **Archivo** (self-hosted) — display + UI. Grotesque, slightly condensed, institutional
  without being corporate; not-fintech, not-AI-serif. Roles: page titles, section headers,
  buttons, body. Use tight tracking on the wordmark (`KONCLAVE`, plain tracked caps — the
  metallic-bevel wordmark is REPLACED).
- **Spline Sans Mono** (self-hosted) — the instrument voice. Roles: **every figure/amount
  (inviolable mono-for-money rule)**, addresses/UFVK, IDs, txids, status codes, ALL-CAPS
  labels, the tarja's "SIGILOSO" text, ledger columns. This is what makes it read as ledger
  and dossier rather than app.
- **Type contract**: Archivo for *language*, Spline Sans Mono for *record*. Money, keys, and
  state are always mono; prose and headings are Archivo. Cap the scale (≈3 sizes/screen) and
  weights (≈2/screen) for instrument restraint.

## The tarja — the signature device (PRESERVE + amplify)

Make the tarja the brand's face, per `audit/evolution-map.md` row 2 and `market-fit.md`.

- **Form**: a solid **redaction bar** as a positive shape — near-black graphite (`#1E1E22`
  or slightly darker) or oxblood ink, with `SIGILOSO` / `SEALED` set in Spline Sans Mono,
  ALL CAPS, wide tracking, in `--silver` or paper-white. Clean edges, no grunge — a
  *treasury clerk's* redaction, not a hacker's.
- **Behavior**: veils a sensitive value; **the reveal is the interaction** (bar collapses
  left / lifts to expose the mono figure). Must be **keyboard-operable** (accessibility
  floor — currently not; this is a hard requirement).
- **Reach**: it is the motif that unifies the identity — the mark, the favicon, the seal,
  and the empty/loading states can all echo the bar. This is the one device to over-invest
  in; it is category-distinct (nobody in the field has it).

## The seal / mark family (EVOLVE — the one place real design is warranted)

- **Concept**: a **wax seal** — matte, embossed-by-tone (NOT bevelled, NOT glossy, NO glow).
  Fill `--seal-deep #7E2A24`, optional brass rim, an emboss suggested purely by a
  one-step-darker inner tone. Legible at 16px.
- **Unify**: mark ⟶ favicon ⟶ quorum medallion are **one object** (kill the purple favicon,
  the dangling logo.png, and the metallic wordmark). The quorum medallion is the seal with
  N notches/segments filling as approvals arrive — trust made visible.
- **Ban-list on the mark**: no glow, no gradient, no chrome/metallic-bevel wordmark, no
  keyhole-cliché-with-lens-flare. Deliberate and flat.

## Imagery, texture, surfaces

- **Texture, sparingly**: a very faint paper/tooth grain (≤0.02 opacity) on the deepest
  ground is *allowed and on-concept* (archival), but must never become "atmospheric noise
  glow." No ambient orbs, no radial gradients, no spotlights.
- **Surfaces**: hairline-bordered, flat. **One elevation budget** — shadow reserved for true
  overlays (modals) only; cards separate by border + tone, not float. This is the concrete
  move away from Gnosis/Safe glass (`evolution-map.md` row 13).
- **No photography.** Type, seal, tarja, and ruled ledger structure carry all the meaning.
- **Motion**: mechanical and brief (150-250ms, ease-out). Kill the infinite pulse (also a
  reduced-motion fail). State changes are stamped, not sprung.

## Overall feel — the litmus test

Every surface should answer *yes* to: "Would Marina, a non-technical treasurer wary after a
crypto scare, read this as a **solid institution she can trust** rather than a **risky crypto
app**?" Graphite + silver + paper + one wax signal + mono figures + a redaction bar + a wax
seal = *sealed treasury instrument.* Blue + glass + glow + gradient wordmark = the thing she
distrusts. The direction is the trust fix and the differentiation fix at once.

---

## Style Affinity

Referenced against `/home/daniel/.claude/skills/gsp-style/styles/INDEX.yml` (read in full).

- **`nothing` — STRONGEST MATCH (near 1:1).** Monochrome industrial precision: near-black
  ground, three flat layers, **a single signal accent used one-per-screen (swap Nothing-red
  `#D71921` → wax `#A5352B`)**, **zero shadows**, mono ALL-CAPS labels, "data as beauty" in
  mono, mechanical motion, and an explicit ban-list (no gradients, no glass, no glow, no
  metallic) that matches Konclave's brief almost verbatim. Adopt its *philosophy and
  constraints* wholesale; substitute Archivo + Spline Sans Mono for Space Grotesk + Space
  Mono, and add the tarja + wax-seal as the ownable devices Nothing lacks. This is the
  reference preset.

- **`minimal-dark` — PARTIAL (structure only, strip the effects).** Useful for its
  **three-layer dark surface model** (deep → base → elevated) and warm-accent instinct. But
  it mandates **glass cards, backdrop-blur, ambient amber glow, and orb-drift** — precisely
  the dark-SaaS vocabulary the brief BANS. Take the layering discipline; discard the glass/
  glow entirely.

- **`terminal` — DISTANT FLAVOR (borrow the mono-instrument, avoid the hacker skin).**
  Aligns on mono-everywhere-as-record, flat shadowless panes, and status-code badges
  (`[OK]`/`[ERR]` echoes Konclave's honest state voice). But its CRT scanlines, phosphor
  glow, terminal-green, and all-monospace mandate read as *hacker terminal* — which the brief
  *also* rejects. Use only as a reminder that mono = instrument; do not adopt the skin.

No single preset is a drop-in. **`nothing` is the spine** (instrument-dark, one signal,
no-shadow, mono-labels, anti-cliché constraints); Konclave layers on the archival/redaction
warmth (paper-white text, wax oxblood, tarja, seal) that no preset carries.

---

## Related
- competitive-audit.md — why the palette must abandon crypto-blue
- trend-analysis.md — redaction / archival / instrument-dark / wax-material sources
- ../audit/evolution-map.md — the PRESERVE/EVOLVE/REPLACE contract this executes
