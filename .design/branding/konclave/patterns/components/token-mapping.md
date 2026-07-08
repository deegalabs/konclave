# Konclave — Token Mapping (the migration map)

> Phase: guidelines | Brand: konclave | Generated: 2026-07-08

The mechanical old->new migration so the CSS consolidation is a find-and-replace, not
a redesign. Strategy: **EXTEND / CONSOLIDATE** — keep every current value (blue accent
`#57a6ff` locked); fix the names; merge `lacre.css` + `redesign.css` + `App.css` into
one token layer; delete the stray oxblood literals.

Apply order (safe, no mid-flight breakage):

1. Add the full new token set to a single `:root` (below).
2. Alias the old names to the new (`--seal: var(--accent);` etc.) so nothing breaks.
3. Sweep the codebase: replace old var names with new (tables below).
4. Delete the aliases and the oxblood literals.

---

## 1. Renamed `:root` tokens — `lacre.css`

| Old | New | Value | Files that reference it |
| --- | --- | --- | --- |
| `--paper` | `--surface-1` | `#171c22` | lacre.css, App.css |
| `--paper-2` | `--surface-2` | `#1e252d` | lacre.css, App.css |
| `--ink` | `--text` | `#dfe6ee` | lacre.css, App.css |
| `--muted` | `--text-muted` | `#8a95a3` | lacre.css, App.css |
| `--line` | `--line` *(kept)* | `#333d47` | lacre.css, App.css |
| `--line-2` | `--line-2` *(kept)* | `#28313a` | lacre.css, App.css |
| `--seal` | `--accent` | `#57a6ff` | lacre.css, App.css |
| `--seal-ink` | `--accent-ink` | `#3f86e0` | lacre.css |
| `--pine` | `--success` | `#57d08a` | lacre.css, App.css |
| `--silver` | `--silver` *(kept)* | `#c6cfd9` | lacre.css, App.css |
| `--sans` | `--font-sans` | `Archivo, system-ui, sans-serif` | lacre.css, App.css |
| `--mono` | `--font-mono` | `"Spline Sans Mono", ui-monospace, monospace` | lacre.css, App.css |

> `--seal` and `--pine` are the two lying names the audit flagged: `--seal` had become
> blue (not wax), `--pine` had become mint (not archival green). Renaming to role
> (`--accent`, `--success`) is the core of this migration.

## 2. Scoped `.rd-*` tokens — `redesign.css` (fold into the shared set)

| Old | New | Value | Note |
| --- | --- | --- | --- |
| `--rd-text` | `--text` | `#dfe6ee` | was `#dde5ee`; unify to `--text` (negligible delta) |
| `--rd-muted` | `--text-muted` | `#8a95a3` | identical |
| `--rd-accent` | `--accent` | `#57a6ff` | identical |
| `--rd-silver` | `--silver` | `#c6cfd9` | identical |
| `--rd-line` | `--line-soft` | `rgba(180,205,235,.10)` | translucent hairline for the lighter cards |
| `var(--mono, monospace)` | `var(--font-mono)` | — | ~15 call-sites in redesign.css use the fallback form |

After this, `.rd` stops being a private dialect: the `.rd-*` **layout** classes stay
(they are just class names on Intro/Vaults), but they consume the **shared** tokens.
Delete the `.rd { --rd-*: ... }` block entirely. This is the fix for "entering a vault
feels like a different app."

## 3. Promote inline literals to tokens (new tokens, values already in the code)

| New token | Value | Currently hardcoded in |
| --- | --- | --- |
| `--surface-0` | `#12161a` | body gradient terminal (lacre.css), redesign.css `#12161a`, unlock-input bg, modal gradient (App.css) |
| `--surface-3` | `#28313a` | raised/hover fill (new role; shares the line-2 tone) |
| `--accent-soft` | `rgba(87,166,255,.10)` | `.chip.on`, `.rd-qtag`, `.word-box`, `.needyou.act` (App.css) |
| `--accent-line` | `rgba(87,166,255,.30)` | `.needyou.act`, `.word-box`, `.unlock-card`, hover borders (App.css, redesign.css) — code uses .28/.30/.40; normalize to .30 |
| `--on-accent` | `#08121e` | `.rd-enter` hover, `.rd-enter.primary`, `.lang-btn.on` (`#06121f`) (redesign.css) |
| `--success-soft` | `rgba(87,208,138,.08)` | `.confirm.ready` (App.css) |
| `--success-line` | `rgba(87,208,138,.40)` | `.pf-st.sent`, `.who-st.ok`, `.plist-count.ready`, `.tag.ok` (App.css) |
| `--warn` | `#ffcf87` | `.hint.warn`, `.word-warn` (App.css) |
| `--warn-strong` | `#ffe0a3` | `.word-warn b` (App.css) |
| `--danger` | `#ff6b6b` | `.hint.err`, `.danger-btn`, `.modal-card.danger`, `.danger-funds` (App.css) |
| `--danger-text` | `#ff9d9d` | `.danger-btn`, `.hint.err` (`#ffb4b4`), `.ns.over` (`#ff8f8f`) (App.css) — normalize the tints to `--danger-text` |
| `--danger-soft` | `rgba(255,90,90,.09)` | `.hint.err`, `.danger-zone`, `.danger-funds` (App.css) |
| `--danger-line` | `rgba(255,110,110,.28)` | `.danger-zone`, `.danger-btn`, `.who-st.no` (App.css) |
| `--tarja-ink` | `#0c1014` | `.secret .bar` bg (lacre.css); also `.btn.danger-btn:hover` ink |
| `--tarja-text` | `rgba(230,227,219,.60)` | `.secret .bar::after` (lacre.css) |
| `--radius` | `12px` | card recipes across App.css/redesign.css (12/14px -> normalize to 12, lg to 16) |
| `--radius-sm` | `8px` | inputs/pills/small controls |
| `--radius-lg` | `16px` | `.entry`, `.cols`, `.modal-card`, `.unlock-card`, `.needyou` |
| `--radius-pill` | `999px` | tags, status pills, avatars |
| `--shadow-overlay` | `0 30px 60px -24px rgba(0,0,0,.8)` | `.modal-card`, `.unlock-card` (App.css/redesign.css) |
| `--dur-fast` | `140ms` | `.op`, `.chip`, `.rd-card`, `.plist-row` transitions (`.12s`/`.14s`) |
| `--dur-reveal` | `280ms` | `.secret .bar` reveal transition (`.28s`) |
| `--ease-out` | `cubic-bezier(.3,.8,.3,1)` | `.secret .bar` reveal (App.css) |

> Near-white heading tints `#f2f6fb` / `#f0f4fa` / `#eaf1fb` (redesign.css hero/card
> titles, `.word-value`, unlock/modal headings) should collapse to `--text` unless a
> deliberate brighter heading tier is wanted; if kept, add one `--text-bright` token
> rather than three literals.

## 4. Delete on sight — oxblood / off-palette literals (dead light theme)

| Literal | Where | Replace with |
| --- | --- | --- |
| `rgba(126,42,36,.35)` | `.link` border-bottom, lacre.css:93 | `color-mix(in srgb, var(--accent) 35%, transparent)` |
| `#7E2A24` | `.cell-warn` fallback, App.css:28 (`var(--seal, #7E2A24)`) | `var(--warn)` (it is a validation warning; drop the oxblood fallback) |
| `#7E2A24` | `.row-del:hover` fallback, App.css:32 (`var(--seal, #7E2A24)`) | `var(--danger)` (delete action -> danger, not accent) |
| `#37493C` | `.livetag` fallback, App.css:13 (`var(--pine, #37493C)`) | `var(--success)` (drop the oxblood-green fallback) |
| `#863bff` (+ `#7e14ff`, `#47bfff`) | `favicon.svg` (purple origami) | derive the favicon from the blue mark; do not ship purple |
| `/logo.png` | `index.html:6` (dead reference) | remove the line; point the icon at the derived favicon |

These are the audit's "three color stories" liability: if any `var()` failed to load,
patches of the dead light/purple palette would reappear. Removing the fallbacks makes
that impossible.

---

## The merge plan (3 files -> one token layer, plain CSS)

**Target:** one `:root` custom-property block is the sole token source; `lacre.css`
becomes the component layer that consumes it; `redesign.css`'s `.rd` token block is
deleted (its layout classes stay, consuming shared tokens); `App.css` stops
re-declaring surfaces and status literals.

1. **Create the token layer.** Put the full `:root { … }` (below) at the top of
   `lacre.css` (or a new `ui/src/tokens.css` imported first in `main.tsx`). Because
   this is plain CSS, tokens are just custom properties — no config, no build step.
2. **Alias, then sweep.** Add `--paper: var(--surface-1)` etc. as temporary aliases;
   run the §1/§2 renames across `lacre.css`, `App.css`, `redesign.css`; delete aliases.
3. **Promote literals (§3).** Replace inline hex/rgba with the new tokens.
4. **Delete oxblood (§4).** Remove the fallbacks and the purple/logo references.
5. **Flatten elevation.** Strip the `0 22px 44px …` card shadows and `translateY(-4px)`
   hover-lift from `.rd-card` / `.entry` / `.cols` / `.needyou` / `.opnav.card`; keep
   only border + tone, with hover -> `--accent-line`. Keep `--shadow-overlay` on
   `.modal-card` / `.unlock-card` only.
6. **Kill the pulse.** Delete `@keyframes rd-pulse` and the animated status dot; make
   the live indicator a static `--success` dot + label.
7. **Kill the glow.** Remove `drop-shadow(... rgba(87,166,255,…))` from `.rd-emblem`,
   `.rd-lockup`, `.rd-create .ic`, and the `Mark`/`Seal` SVGs.
8. **Replace the wordmark.** Drop `.rd-brand`'s `background-clip:text` metallic bevel;
   use the tracked-mono `KONCLAVE` from `.wm`.

Once done, `redesign.css` is either empty of tokens (layout-only) or folded into
`lacre.css`; there is one vocabulary.

### The `:root` to paste (plain CSS)

```css
:root{
  /* surfaces */
  --surface-0:#12161a; --surface-1:#171c22; --surface-2:#1e252d; --surface-3:#28313a;
  /* text */
  --text:#dfe6ee; --text-muted:#8a95a3; --silver:#c6cfd9;
  /* lines */
  --line:#333d47; --line-2:#28313a; --line-soft:rgba(180,205,235,.10);
  /* accent (blue — rare, interactive + quorum) */
  --accent:#57a6ff; --accent-ink:#3f86e0;
  --accent-soft:rgba(87,166,255,.10); --accent-line:rgba(87,166,255,.30);
  --on-accent:#08121e;
  /* success (earned) */
  --success:#57d08a; --success-soft:rgba(87,208,138,.08); --success-line:rgba(87,208,138,.40);
  /* warn */
  --warn:#ffcf87; --warn-strong:#ffe0a3;
  /* danger */
  --danger:#ff6b6b; --danger-text:#ff9d9d;
  --danger-soft:rgba(255,90,90,.09); --danger-line:rgba(255,110,110,.28);
  /* signature devices */
  --tarja-ink:#0c1014; --tarja-text:rgba(230,227,219,.60);
  /* type */
  --font-sans:"Archivo",system-ui,sans-serif;
  --font-mono:"Spline Sans Mono",ui-monospace,monospace;
  /* shape */
  --radius:12px; --radius-sm:8px; --radius-lg:16px; --radius-pill:999px;
  /* elevation — overlays only */
  --shadow-overlay:0 30px 60px -24px rgba(0,0,0,.8);
  /* motion */
  --dur-fast:140ms; --dur-base:240ms; --dur-reveal:280ms;
  --ease-out:cubic-bezier(.3,.8,.3,1);
}
/* light-ready: a future theme is a values-only override, no renames
:root[data-theme="light"]{ --surface-1:#…; --text:#…; … } */
```

Buttons, inputs, the tarja, the stamp, and table rules stay **squared** (radius 0) —
the instrument edge. Cards, modals, and pills use the radius tokens.
