# Coherence Assessment — Konclave

> Phase: audit | Brand: konclave | Generated: 2026-07-08

---

Three coherence axes, each scored 1-5, with the concrete disconnects named. The headline:
the dark *instinct* is right and the typography is genuinely coherent, but the system was
built as an **in-place recolor, not a migration**, so it ships three color stories, two CSS
vocabularies, and a token layer whose names lie.

## Scores

| Axis | Score | One-line verdict |
|---|---|---|
| Strategy coherence | **4/5** | The brand idea (solid vault + discretion, privacy-as-gesture, hide-the-crypto) is clear, singular, and documented. Only drift: is it "archival instrument" or "premium dark dev-tool"? Never decided. |
| Strategy ↔ visual alignment | **3/5** | Discretion lands (tarja, mono, restraint). But floating-glass cards, glow-on-everything, a metallic web3 wordmark, and a pulsing dot are exactly the dark-SaaS clichés the brief bans. |
| Internal consistency | **2/5** | The weakest axis. Two CSS systems, three color stories, lying token names, oxblood literals, a purple favicon, a dangling logo.png, an untokenized semantic palette. |

## Disconnect 1 — three color stories in one app

A user meets all three before doing anything:
- **Silver + blue on slate** (intended dark brand): `lacre.css` + `redesign.css`.
- **Purple** (`#863bff`/`#7e14ff`/`#47bfff`): the actual browser-tab favicon — off-palette,
  off-concept, glow-heavy origami. The one asset seen *before render* fights the whole app.
- **Oxblood** (`#7E2A24`, `#37493C`, `rgba(126,42,36,.35)`): stale light-theme literals
  hiding in `App.css` fallbacks and a `lacre.css` link underline. If a var ever fails to
  load, patches of the dead light palette reappear.

The blue itself is defensible as a value, but **`#57a6ff` reads as generic
crypto-dashboard, not vault** — it is the same friendly link-blue every dark SaaS ships. A
vault brand wants a more reserved, cooler, less "SaaS-primary" accent, or the blue used far
more sparingly (interactive + quorum only) against silver as the true secondary.

## Disconnect 2 — two CSS vocabularies, partial migration

- `lacre.css` (global, semantic-ish token names) governs 9 of 11 screens.
- `redesign.css` (`.rd`, raw-hex `--rd-*` plus ~25 loose hexes) governs only `Intro.tsx` and
  `Vaults.tsx` — literally the first two screens a user sees.
- The comment at `redesign.css:3` ("Escopo em .rd para não mexer nas telas antigas ainda")
  confirms `.rd` was a temporary beachhead never finished.

Consequence: **entering a vault feels like a different app.** Intro/Vaults are soft, rounded,
gradient-carded, glowing; the core (Dashboard onward) is dense, sharp-edged, mono-heavy.
Same product, two design tones, and the same card concept coded twice in two dialects that
will drift.

## Disconnect 3 — the token vocabulary lies

`lacre.css:8` keeps the *names* of the old light system but flipped the *values*:
- **`--seal: #57a6ff`** — "seal" now means blue. It was oxblood wax; the product is *named*
  after a wax seal. Every `.confirm`, `.stamp`, `.chip.on`, focus ring, link, and quorum
  accent paints blue under a token literally named after red wax. Anyone reading the CSS is
  misled about intent.
- **`--pine: #57d08a`** — was muted archival green; now a mint/success green. It silently
  became `--success` (received / confirmed / live) without being renamed.

Fix direction (for the identity phase): rename to role — `--accent` (was `--seal`),
`--success` (was `--pine`), `--surface-1/2` (was `--paper/--paper-2`), `--text/--text-muted`
(was `--ink/--muted`). Ship via alias → sweep → delete so nothing breaks mid-flight.

## Disconnect 4 — the favicon / mark / lockup are three unrelated objects

`index.html` points at a deleted `/logo.png`, falls to a purple origami `favicon.svg`, while
the header renders `Mark()` (silver spokes + blue keyhole). None derives from another. The
one thing a mark must do — be the same object in tab, header, and lockup — is not true here.
(See market-fit and evolution-map: the mark is the single element that warrants real design
work, not just consolidation.)

## Disconnect 5 — the anti-cliché brief vs the glow budget

The brief bans "floating glass + glow." The system ships:
- floating cards, `box-shadow: 0 22px 44px -24px` + `translateY(-4px)` hover + blue hover
  glow (`redesign.css:57-68`);
- glow on the mark, the seal, the emblem, the lockup (`drop-shadow(... rgba(87,166,255,…))`);
- an infinite pulsing green status dot (`@keyframes rd-pulse`);
- a metallic bevel wordmark (`.rd-brand`, `background-clip:text`) — chrome / "web3" texture.

None is catastrophic, but together they push the identity from "sealed dossier" toward
"handsome generic dark crypto product." That is a defensible pivot — but it must be a
**decision** with one stated glow/elevation budget, not an accident of recoloring.

## Disconnect 6 — semantic colors are untokenized literals

Warn (`#ffcf87`), danger (`#ff6b6b` and its tints), and accent-tint fills are hardcoded
across `App.css` with no `--warn` / `--danger` / `--accent-soft` tokens. The system has no
single place to define its status palette — so status color drifts per screen.

## What is already coherent (do not touch)

- **Typography.** Archivo + Spline Sans Mono is consistent across *both* CSS systems and
  every screen, self-hosted, and genuinely not-fintech / not-AI-serif. The fully-resolved
  layer.
- **The mono-for-money rule.** Every figure is mono; the ledger reads as an instrument.
- **The tarja concept.** One gesture, one meaning, used consistently.
- **Voice.** Domain translation is disciplined and singular.

---

## Related

- brand-inventory.md — the raw catalog these disconnects reference
- evolution-map.md — the fix for each disconnect (rename / merge / replace)
- market-fit.md — whether the blue-crypto-dashboard read hurts differentiation
