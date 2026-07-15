# Konclave — STYLE.md (agent contract)

> Phase: guidelines | Brand: konclave | Generated: 2026-07-08

The operational contract for building Konclave UI. Rendered from `konclave.yml`.
Source of truth for the token migration is `components/token-mapping.md`.

Konclave is **dark-first** (dark-only today; the tokens are structured so a light
theme is a values-only override later). Stack: Vite/React/TS in `ui/` with **plain
CSS** — no Tailwind, no shadcn. Tokens are CSS custom properties in `:root`.

**Owner decision (locked): keep the current dark theme + blue accent `#57a6ff`.**
This is a **consolidation, not a rebrand**. Do not introduce a new palette. The
researcher's oxblood "Wax & Graphite" pivot was declined; use this doc's language,
not its colors.

---

## Intensity

| Dial | Value | What it means in build |
| --- | --- | --- |
| Variance | 2 | Strict, ruled, ledger-like grids. The tarja is the one ornament. No layout flourish. |
| Motion | 2 | Motion confirms or reveals only. No infinite pulse, no glow-sweep, no spinners. |
| Density | 6 | Dense-but-legible ledger/payroll tables. |

Net: an **instrument**, not a dashboard. Calm, matte, precise.

---

## Brand in a paragraph

Konclave is the vault that decides together: a local-first desktop app that puts a
human layer over the Zcash Foundation's threshold-signature tools so a group can hold
funds no single person can move. The feeling is **solid vault + discretion** — trust
through structure, not decoration. Privacy is a **physical gesture**: the *tarja*, a
redaction bar that veils a sensitive figure until someone chooses to reveal it. The
surface reads as a **sealed treasury instrument** — graphite panels, silver numerals,
mono figures on a ruled ledger, one deliberate blue signal for the things that carry
trust (focus, the primary action, and quorum). It is explicitly **anti generic
dark-SaaS**: no floating glass, no glow-on-everything, no gradient "web3" wordmark.
Honest, calm, precise. *Private on the outside, transparent on the inside.*

---

## Philosophy

The palette is **achromatic by default, one signal by intent**. Graphite surfaces,
warm-grey text, and **silver as the working metal** carry almost everything. The **blue
accent (`--accent` `#57a6ff`) is rare and meaningful** — it appears on the focused
field, the primary action, links, and, above all, **quorum**: the seal, the approval
progress, the "your signature is needed" call. When the blue is everywhere it means
nothing; keeping it scarce is what makes "this needs you / this is approved" read as a
real event. **Silver is the secondary** — numerals, key labels, mark strokes — never
the blue.

**Success is earned.** `--success` `#5ed39a` (mint) is confirmation only: quorum met,
sent, received, live. Never ambient, never decorative.

**Cryptography is invisible.** The user sees vault, members, approval, payment — never
"FROST", "DKG", "nonce", "SIGHASH". State is a designed stamp, not a lock emoji. Copy
is honest and active: **Propose -> Approve -> Sent**. Every action that moves funds has
a **preview and an explicit confirm**; one click never sends money.

---

## Tokens (the truthful set)

The old token names *lied* (`--seal` was blue, not wax; `--pine` was mint). These are
the role-based replacements. Full old->new table + files: `components/token-mapping.md`.

| Token | Value | Role | Was |
| --- | --- | --- | --- |
| `--surface-0` | `#0f141a` | app canvas / deepest ground | body-gradient terminal |
| `--surface-1` | `#151b22` | panels, sheet base | `--paper` |
| `--surface-2` | `#1a212a` | cards, inputs, chips, wells | `--paper-2` |
| `--surface-3` | `#202832` | raised / hover / selected fill | (line depth) |
| `--text` | `#e7edf3` | headings, body, lead figures | `--ink` / `--rd-text` |
| `--text-muted` | `#9aa6b2` | metadata, labels, captions | `--muted` / `--rd-muted` |
| `--silver` | `#c6cfd9` | secondary metal: numerals, key labels, strokes | `--silver` / `--rd-silver` |
| `--line` | `#28313c` | primary divider, letterhead rule | `--line` |
| `--line-2` | `#20272f` | soft card border | `--line-2` |
| `--line-soft` | `rgba(180,205,235,.08)` | translucent hairline | `--rd-line` |
| `--accent` | `#57a6ff` | focus, primary action, links, **quorum** | `--seal` (misnamed) |
| `--accent-ink` | `#3f86e0` | hover / pressed accent fill | `--seal-ink` |
| `--accent-soft` | `rgba(87,166,255,.10)` | wash / chip.on fill | (inline) |
| `--accent-line` | `rgba(87,166,255,.32)` | accent border | (inline) |
| `--on-accent` | `#0f141a` | ink on an accent fill | `--paper` / rd |
| `--success` | `#5ed39a` | quorum-met, sent, received, live | `--pine` (misnamed) |
| `--success-soft` | `rgba(94,211,154,.10)` | success fill | (inline) |
| `--success-line` | `rgba(94,211,154,.35)` | success border | (inline) |
| `--warn` | `#ffcf87` | address warning, expiring-soon | (hardcoded) |
| `--warn-strong` | `#ffe0a3` | emphasized warn | (hardcoded) |
| `--danger` | `#ff6b6b` | destructive border/accent | (hardcoded) |
| `--danger-text` | `#ff9d9d` | danger text on dark | (hardcoded) |
| `--danger-soft` | `rgba(255,90,90,.09)` | error fill | (hardcoded) |
| `--danger-line` | `rgba(255,110,110,.28)` | danger border | (hardcoded) |
| `--tarja-ink` | `#0c1014` | the redaction bar fill | (hardcoded) |
| `--tarja-text` | `rgba(230,227,219,.60)` | the "SEALED" label | (hardcoded) |
| `--font-sans` | `Archivo, system-ui, sans-serif` | language | `--sans` |
| `--font-mono` | `"Spline Sans Mono", ui-monospace, monospace` | record | `--mono` |
| `--radius` / `-sm` / `-lg` / `-pill` | `12` / `8` / `16` / `999px` | card / control / large / pill | (inline) |
| `--shadow-overlay` | `0 30px 60px -24px rgba(0,0,0,.8)` | overlays ONLY | (was on cards too) |
| `--dur-fast` / `-base` / `-reveal` | `140` / `240` / `280ms` | hover / base / tarja | (inline) |
| `--ease-out` | `cubic-bezier(.3,.8,.3,1)` | motion easing | (inline) |

---

## Color-usage rules

- **The accent (blue) is rare.** Use it for: `:focus-visible` rings, the primary
  action (`.btn.ok`), links, and **quorum** (seal fill, approval progress, "needs you").
  Never as body text, never as a decorative fill, never more than a couple of marks per
  screen.
- **Silver is the secondary,** not the blue. Numerals, key labels, member names, mark
  strokes lean silver/`--text`.
- **Mono ALWAYS for the record.** Money, addresses, UFVKs, txids, IDs, state codes,
  counts, dates, and ALL-CAPS labels are Spline Sans Mono. Prose and headings are
  Archivo. If it is a number, a key, or a machine-state, it is mono — no exceptions.
- **Right-align numeric columns** so decimals stack. Ledger `in` -> `--success`,
  `out` -> `--text`.
- **Success is earned.** `--success` only on confirmed/sent/received/live. Never ambient.
- **One warn, one danger.** Address warnings and expiry use `--warn`; destructive and
  error use `--danger` / `--danger-text`. No per-screen literals.

---

## Typography

- **Archivo** (self-hosted) — *language*: page titles (800, uppercase, tight), section
  headers (700), buttons (700, uppercase), body (400, lh 1.5).
- **Spline Sans Mono** (self-hosted) — *record*: every figure/amount, addresses, txids,
  IDs, state, dates, and the ALL-CAPS mono labels (`--text-muted`, `.18em` tracking).
- **The wordmark** is `KONCLAVE` in mono 600, letter-spacing `0.42em` — the plain
  tracked caps already in the letterhead. **Not** the metallic-bevel / `background-clip`
  wordmark (that is removed).
- Cap the scale to ~3 sizes and ~2 weights per screen for instrument restraint.

---

## Signature devices

### The tarja (redaction bar) — the brand's face

The one ownable device; over-invest here. A solid bar (`--tarja-ink`) with a faint
vertical hatch and `SEALED` / `SIGILOSO` set in mono, wide-tracked, `--tarja-text`. It
**veils a mono figure; the reveal is the interaction** — the bar collapses left
(`scaleX(0)`, origin left) over `--dur-reveal` to expose the value.

- **Hard requirement: keyboard-operable.** It is currently a bare `<div>`. It MUST be
  `role="button"`, `tabindex="0"`, toggle on Enter/Space, expose `aria-pressed`, and
  show a visible focus ring. A privacy gesture the keyboard cannot reach is a bug.
- Clean edges, no grunge — a treasury clerk's redaction, not a hacker's.

### The quorum seal / medallion

A **matte, embossed-by-tone** seal (`--surface-2` field, `--accent` number and filled
notches). **No glow, no gradient, no bevel.** N segments fill as approvals arrive —
quorum made visible. It is the visible sibling of the mark.

### The stamp

The rotated (`-4deg`) mono state tag. Default `--accent`; `sent`/`confirmed` ->
`--success`; `rejected`/`expired`/`cancelled` -> `--danger`. Squared, uppercase.

### Identicons

Deterministic symmetric grids (steel-blue on surface), `--radius-sm`, with a 2px
surface ring. Local-first faces for members; quiet, on-brand.

---

## Surfaces & the ONE elevation rule

**Flat by default.** Cards separate by **border + surface tone**, never by float.
Depth ramp: `--surface-0` (canvas) -> `--surface-1` (panels) -> `--surface-2` (cards)
-> `--surface-3` (hover/raised). Borders: `--line` (dividers), `--line-2` / `--line-soft`
(cards).

**Shadow exists at exactly one level: overlays.** `--shadow-overlay` is for modals and
popovers only. The current card recipe carries `0 22px 44px` shadows + `translateY(-4px)`
hover lift + hover glow — **remove all three**; hover is a border-brighten to
`--accent-line`, no transform. This is the concrete move away from floating-glass
dark-SaaS.

A faint archival paper grain (radial dot, 3px tile, opacity <= 0.05, fixed) on the
deepest ground is allowed and on-concept. It must never become "atmospheric glow."

---

## Motion budget

Mechanical and brief. `--dur-fast` (140ms) for hover/state, `--dur-reveal` (280ms) for
the tarja, `--ease-out` everywhere. Only two things move: **hover** (border-brighten /
alpha-step) and the **tarja reveal**. State changes are *stamped*, not sprung.

- **Kill the infinite pulse.** The looping green status dot (`@keyframes rd-pulse`) is
  removed — it is decoration and a reduced-motion failure. Live-ness is a static
  `--success` dot + label.
- **Kill glow-on-everything.** No `drop-shadow(... rgba(87,166,255,…))` on the mark,
  lockup, seal, or emblem. Matte only.
- Gate every animation on `prefers-reduced-motion` (drop to instant state swaps).

---

## Constraints

### Never

- Introduce a new palette or a new hue. The accent is blue `#57a6ff`, locked.
- Use the accent (blue) as body text or decoration; it is interactive + quorum only.
- Render a figure, address, txid, ID, or state in a non-mono face.
- Put a drop shadow on a non-overlay surface, or a hover-lift on a card (floating glass).
- Put glow / drop-shadow on the mark, lockup, seal, or emblem.
- Ship a metallic-bevel / `background-clip:text` wordmark, a gradient "web3" wordmark,
  or glow spam — the anti-dark-SaaS ban.
- Run an infinite / looping animation.
- Leave the oxblood literals `#7E2A24`, `#37493C`, `rgba(126,42,36,.35)` anywhere, or
  the purple `#863bff` favicon. Delete on sight.
- Remove an input focus outline without providing a visible ring.
- Ship a tarja or nav the keyboard cannot operate.
- Use emoji, em-dashes, or crypto jargon (FROST/DKG/nonce/SIGHASH) in product copy.

### Always

- Mono + right-align on every amount, address, txid, ID, count, and date.
- Elevation by border + surface tone; shadow only on overlays.
- Accent used sparingly and meaningfully (focus, primary action, links, quorum).
- Silver as the true secondary metal.
- Success earned, never ambient.
- A visible focus ring on every interactive element.
- The tarja and nav keyboard-operable.
- Self-hosted fonts, no external CDN.
- Honest active voice; preview + explicit confirm on every money action.
- Gate all motion on `prefers-reduced-motion`.

---

## Effects (interaction vocabulary)

| Effect | Trigger | Treatment | Duration |
| --- | --- | --- | --- |
| border-brighten | hover/focus on cards, rows, chips | `--line` -> `--accent-line` (no transform) | `--dur-fast` |
| accent-focus | `:focus-visible` on inputs/fields | `border-color` -> `--accent` + visible ring | `--dur-fast` |
| alpha-step | row / op hover | subtle `--accent-soft` -> transparent gradient wash | `--dur-fast` |
| tarja-reveal | sensitive value disclosed | bar collapses left (`scaleX(0)`, origin left), one-time | `--dur-reveal` |

Forbidden: spotlight, glow-sweep, pulsing/looping glow, hover-lift.

---

## Voice

Honest, Calm, Precise.

- Say "payment", "approve", "quorum", "vault" — never "FROST", "DKG", "SIGHASH", "nonce".
- Active and truthful: **Propose -> Approve -> Sent**. States always visible.
- Distinguish a cryptographic guarantee from a product rule (quorum-by-value and balance
  reserve are product, not protocol) — even in copy.
- No emoji, no em-dashes, no exclamation-mark hype.
- Credit the Zcash Foundation tooling explicitly; do not overclaim.
- Bilingual: PT-BR default, EN. The tarja label is `SIGILOSO` (PT) / `SEALED` (EN).

Motif line: **Propose. Approve. Sent.**

---

## Accessibility floor

- **Visible focus ring** on every interactive element (never `outline:none` without a
  replacement — several current inputs strip the outline; add a ring).
- **The tarja and nav are keyboard-operable** (`role`, `tabindex`, Enter/Space,
  `aria-pressed`).
- Respect `prefers-reduced-motion`.
- Text contrast meets WCAG AA on its surface; `--text-muted` is for metadata, not body.
- Status is never color-alone — pair the dot/tint with a label or stamp.

---

## Local-first constraints

- **Self-hosted fonts** (`@fontsource` in `ui/src/main.tsx`). No Google Fonts, no
  external CDN in the shipped app.
- No telemetry; secrets never in log, disk, or URL (a product-wide rule, echoed here).
- `guidelines.html` is a standalone preview and may `@import` fonts for convenience; the
  app must not.
