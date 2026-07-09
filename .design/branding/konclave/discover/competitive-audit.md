# Competitive Audit — Konclave

> Phase: discover | Brand: konclave | Generated: 2026-07-08
> The real rivals (from BRIEF.md, `audit/market-fit.md`, `temp/05`) placed on two axes,
> with each one's **visual language** dissected, and where Konclave should sit.

---

## Positioning map — Conservative ↔ Progressive × Traditional ↔ Modern

- **X axis — Conservative ↔ Progressive**: visual risk / expressiveness. Conservative =
  restrained, institutional, quiet. Progressive = expressive, trend-forward, decorative.
- **Y axis — Traditional ↔ Modern**: reference era. Traditional = archival, print, ledger,
  physical-object metaphors. Modern = screen-native, app/dashboard, digital metaphors.

```
                 MODERN (screen-native / dashboard)
                              │
        frost-ui ○           │           ○ Gnosis Safe
      (web-form,             │        (glass, glow, blue/violet
       unbranded)            │         gradients — the banned look)
                             │           ○ Zashi
                             │        (clean modern mobile wallet)
   CONSERVATIVE ─────────────┼───────────────────────── PROGRESSIVE
   (restrained/              │
    institutional)  ○ Zkool  │
                 (utilitarian,│        ★ KONCLAVE (target)
                  dev-facing) │     sealed treasury instrument /
                             │      archival ledger — restrained,
                             │      traditional-referent, distinctive
                 TRADITIONAL (archival / print / physical)
```

Konclave's target quadrant — **Conservative + Traditional, edging toward the center** — is
**empty in this field.** Every rival clusters in the Modern band; only Zkool drifts
conservative but stays screen-utilitarian, not archival. That empty quadrant is the brand.

## The rivals, visually

### Zkool (hhanh00) — closest peer
- **What**: power-user shielded-FROST wallet (DKG, Orchard), Flutter/Dart UI. `temp/15` #2.
- **Visual signature**: utilitarian, information-dense, developer-facing. Function-first
  Flutter default chrome; little brand-level art direction. Reads as *a tool a developer
  made for developers.*
- **Read**: strong engineering credibility, low brand warmth. Non-technical Marina bounces.
- **Konclave line**: same crypto, opposite *stance* — a designed, branded instrument for a
  treasurer, not a control panel for a power user.

### lamb356 / frost-ui (Carson) — direct UI-layer peer
- **What**: hosted web/WASM FROST UI, ZF grant. `temp/15` #3.
- **Visual signature**: generic web-form / crypto-tool chrome; utilitarian, unbranded,
  browser-native. Purpose-built for the protocol, not for a persona.
- **Read**: proves the protocol works in a browser; no ownable visual identity.
- **Konclave line**: local-first *desktop* + a real identity; the key share never leaves
  the device, and the product looks like it belongs to the group, not to a webpage.

### Zashi / Ywallet / Zingo — the polished personal wallets
- **What**: single-user shielded wallets. Zashi (ECC) is the polish benchmark. `temp/15` #2.
- **Visual signature**: clean, modern mobile-wallet craft — rounded cards, soft dark,
  restrained color, good type. Zashi is genuinely well-made and *shielded-first sober*
  (not neon-crypto). This is the closest competitor to Konclave *in tone*.
- **Read**: the bar for "shielded wallet done tastefully." But it is a **personal** object;
  no quorum, no seal, no collective-custody language, no ledger/accounting surface.
- **Konclave line**: match Zashi's restraint, then add what a personal wallet structurally
  cannot: **quorum, countersignature, the seal, the ledger.** Do not out-polish Zashi;
  out-*concept* it.

### Gnosis Safe / MPC custody (Fireblocks, etc.) — the treasury incumbents
- **What**: collective multisig treasury — but fully transparent on-chain. `temp/05` §3.
- **Visual signature**: **the exact banned look** — polished dark web3 dashboard, floating
  glass cards, glow, blue-to-violet gradients, metallic/gradient wordmarks, data-viz
  everywhere. This is 2023-era "premium dark crypto" as a genre.
- **Read**: authoritative for crypto-natives, but it *is* the aesthetic Marina distrusts —
  and, per `audit/market-fit.md`, Konclave's current `#57a6ff` + glass + glow is
  accidentally **converging on this exact look.**
- **Konclave line**: "Safe, but the amounts are actually private" — and it must *look* as
  different from Safe as it is functionally different. Chromatically abandoning the Safe
  blue is the fastest way to stop reading as a Safe clone.

## Where Konclave should sit — and the two moves to get there

Target quadrant: **Conservative-Traditional, pulled just toward center for approachability.**
The identity gets there with two chromatic/structural moves the `audit` already prescribed:

1. **Abandon crypto-blue `#57a6ff`.** It is nearly Gnosis/Linear/Safe link-blue. It is the
   single strongest force dragging Konclave into the Gnosis quadrant. (See
   `mood-board-direction.md` for the replacement.)
2. **Flatten the surfaces and cut the glow.** Floating glass + hover-lift + drop-shadow is
   Gnosis vocabulary. Hairline surfaces + reserved elevation is treasury-instrument
   vocabulary.

The differentiators no rival owns — the **tarja** (privacy-as-physical-redaction) and
**mono-for-money** (ledger instrument) — are what actually move Konclave into the empty
quadrant. Nobody else has a motif; everyone else has a lock icon and a blur. That is the
whole game.

---

## Related
- market-landscape.md — the category and persona visual expectations
- trend-analysis.md — the aesthetics that support the target quadrant
- mood-board-direction.md — the palette/type/tarja that lands the position
- ../audit/market-fit.md — the source read on blue-as-Gnosis and glow-as-dashboard
