# Equity Analysis — Konclave

> Phase: audit | Brand: konclave | Generated: 2026-07-08

---

What in the shipped identity carries genuine equity — real recognition/trust value worth
preserving — versus what survives only by **inertia** (it's there because nobody removed it).
The test for equity: *does this element make Konclave more itself, and would removing it
cost the brand something a user or persona would notice?* This is an evolve, not a rebrand,
so the default is "keep" — but keeping the wrong things is how consolidation fails.

## Genuine equity — preserve and amplify

### The tarja / redaction gesture — HIGHEST equity

The `"SIGILOSO"` bar that veils a value and collapses to the left on reveal
(`components.tsx:52`, `lacre.css:66`, `App.css:115`). This is the brand's one truly ownable
device — no competitor turns privacy into a physical artifact (see market-fit). It directly
embodies the positioning ("private on the outside") and the UX law ("expose the trust"). It
is recognizable, conceptual, and category-distinct. **This is the equity the whole evolution
should be built around.** Caveat: it is currently mouse-only (a `<span onClick>` with no
role/keyboard/ARIA) — the *equity is in the gesture*, and the gesture must survive being made
keyboard-operable (a `<button aria-pressed>`). Amplify, don't just preserve.

### Mono-for-money — HIGH equity

Every figure, address, txid, and micro-label in Spline Sans Mono. This is what makes
Konclave read as a *ledger / instrument* rather than a wallet, and it serves the accountant
persona directly. Consistent across both CSS systems and every screen. Real recognition
value; keep as an inviolable rule.

### Archivo + Spline Sans Mono pairing — HIGH equity

Institutional grotesque (display/UI) + ledger mono (data). Genuinely not-fintech,
not-AI-serif, and now self-hosted (local-first compliant). The single fully-coherent layer
of the system. This pairing *is* the typographic brand. Preserve exactly.

### Deterministic identicons — MEDIUM equity

Steel-blue symmetric grids (`avatar.tsx`) that give members a face without a hex key and
without a network fetch. On-brand (quiet, local-first) and serves the members persona. Worth
keeping; low-drama. Their steel-blue palette should follow whatever the accent/silver
decision becomes so they stay in-family.

### The wax-seal *concept* (the name itself) — HIGH latent equity, LOW current equity

"Konclave" and "Lacre" both point at a sealed instrument / wax seal. That concept has strong
latent equity — it is the product's name and story. But the current `Seal()` **artifact**
(compass-rose rings + blue glow) reads as a gauge/badge, not a seal, so the equity is
*latent, not realized*. Preserve the concept; the artifact is an evolve/redesign target
(evolution-map).

## Equity by inertia — do not preserve just because it's shipped

### The blue accent `#57a6ff` — inertia, not equity

It works as a value but carries no distinct recognition — it is the default crypto-dashboard
blue (market-fit). Nobody would recognize Konclave *by* this blue. Keep it only if a
deliberate decision says so; treat it as replaceable, not sacred. No sunk-cost.

### The `Mark()` glyph — inertia

Ambiguous at 22px (sun/asterisk/compass, not key/vault), glow-decorated, and not mirrored by
the favicon. It has been shipped, but it has not earned recognition — a user could not draw
it from memory. No equity to protect; this is the one element that warrants real design.

### The floating-glass card treatment + glow + pulse — inertia (and negative equity)

These are shipped but actively *cost* the brand — they pull toward the dark-SaaS cliché the
brief bans (coherence, market-fit). Not equity; a liability that survived by recoloring.

### The purple favicon — negative equity

Off-palette, off-concept, glow-heavy. It only recognizes Konclave as "unfinished." Remove.

### The metallic-bevel wordmark `.rd-brand` — inertia

Chrome/"web3" texture at odds with "carimbo institucional." Shipped on two screens only. No
recognition value; drop in favor of the plain tracked mono wordmark already used elsewhere.

## Equity summary

| Element | Equity verdict | Action implied |
|---|---|---|
| Tarja / redaction | Genuine, highest | Preserve + amplify (make it the face) |
| Mono-for-money | Genuine, high | Preserve (inviolable rule) |
| Archivo + Spline pairing | Genuine, high | Preserve exactly |
| Identicons | Genuine, medium | Preserve (follow accent) |
| Seal *concept* / the name | Latent, high | Preserve concept, redesign artifact |
| Blue `#57a6ff` | Inertia | Reconsider; not sacred |
| `Mark()` glyph | Inertia | Redesign |
| Floating glass / glow / pulse | Inertia / negative | Reduce to a stated budget |
| Purple favicon | Negative | Replace |
| Metallic-bevel wordmark | Inertia | Drop |

---

## Related

- market-fit.md — why the tarja and mono are the differentiators to amplify
- evolution-map.md — turns each verdict into a PRESERVE/EVOLVE/REPLACE decision
