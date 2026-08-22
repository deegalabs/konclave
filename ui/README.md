# ui/: Layer 3 (interface)

The human experience. **Vite + React + TypeScript** as a static bundle
([ADR-0003](../docs/adr/0003-vite-over-nextjs.md) revised the originally considered
Next.js - inapplicable to a local-first app with no server). Served locally by the
Orchestrator's loopback HTTP bridge (`konclave serve`, [ADR-0004](../docs/adr/0004-local-http-bridge.md)),
not by Tauri (packaging as a single desktop binary is a roadmap item). Master principle:
**hide the cryptography, expose the trust**. The user sees vault, members, approval,
payment; never "FROST", "DKG", "SIGHASH". The interface is **bilingual** (PT-BR default + EN,
a dependency-free i18n with a language toggle).

## Screens
Intro · Create/Join vault (Ceremony) · Dashboard (balance / pending / history) ·
New Payment · New Payroll · Proposal (approve/refuse) · Sent (explorer link) ·
Ledger · Members · Receive · Docs · plus the network surfaces (`/net`, `/signer`,
`/proof`, `/recovery`, `/inheritance`).

## Interaction rules
- Every action that moves funds: **preview + explicit confirmation**. Never a single click.
- Honest, active copy ("Propose payment" → "Approve" → "Sent").
- Errors guide, they do not apologize. States always visible.
- Privacy as a gesture: native hide/show balance.
- Baseline accessibility: keyboard focus, contrast, reduced motion (WCAG 2.2 AA pass).

## Design
Design system **"Lacre"** (`ui/src/lacre.css`): token system (palette, typography,
signature element) derived from the Zcash/Orchard world, consolidated through the GSP
brand pipeline (see `.design/branding/konclave/` and `STYLE.md`).

## Data
Wired to live data through `ui/src/api.ts` (the loopback `/api/*` bridge) with a fallback
to the mock (`ui/src/mock.ts`, gated on `VITE_DEMO` for the hosted demo). Run: `npm run dev`
(Vite dev server, `/api` proxied to the bridge) · `npm run build` · `npm run lint`.

## Environment (build-time `VITE_*`)
- `VITE_RELAY_BASE` - hosted blind relay for `/net` (empty = the local bridge, same origin).
- `VITE_HELPER_BASE` - hosted **blind helper** (ADR-0006 Rung A) for `/net`. When set, a
  finished browser-DKG vault is registered with the helper, which derives its real Orchard
  address (view-only) and can later drive sends over Architecture B. Empty = `/net` stays a
  pure device-to-device ceremony with no hosted vault (`ui/src/helper.ts` degrades to `null`).
  The demo points it at the Railway helper (`konclave-helper-production.up.railway.app`).
- `VITE_DEMO` - hosted-demo mode (reads fall back to `ui/src/mock.ts`).
