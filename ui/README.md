# ui/: Layer 3 (interface)

The human experience. **Vite + React + TypeScript** as a static bundle
([ADR-0003](../docs/adr/0003-vite-over-nextjs.md) revised the originally considered
Next.js - inapplicable to a local-first app with no server). Served as a static site on the web
(the delivery members use), locally by the Orchestrator's loopback HTTP bridge (`konclave serve`,
[ADR-0004](../docs/adr/0004-local-http-bridge.md)), and inside the Tauri desktop shell (latest
v0.13.2, a pre-release not yet validated on real hardware). Master principle:
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
Wired to live data only, through `ui/src/api.ts` (the loopback `/api/*` bridge) or the hosted
coordinator (the helper) for browser-created vaults. There is no mock/demo dataset: a screen with no data renders its
empty state. Run: `pnpm run dev` (Vite dev server, `/api` proxied to the bridge) ·
`pnpm run build` · `pnpm run lint` · `pnpm run test`.

## Environment (build-time `VITE_*`)
- `VITE_RELAY_BASE` - hosted blind relay, where the devices meet for the DKG and to sign (empty = the
  local bridge, same origin). The hosted build points it at `https://relay.konclave.xyz`.
- `VITE_HELPER_BASE` - the hosted **coordinator** (the helper, ADR-0006 Rung A). When set, a
  finished browser-DKG vault is registered with the helper, which derives its real shielded
  address and viewing key (it never holds a share) and can later drive sends over Architecture B. Empty = `/net` stays a
  pure device-to-device ceremony with no hosted vault (`ui/src/helper.ts` degrades to `null`).
  The hosted build points it at `https://helper.konclave.xyz`.
- `VITE_API_BASE` - base for the local bridge's `/api/*` (empty = same origin, which is how the bridge
  serves this bundle; `npm run dev` proxies it).

The production values live in the Vercel project's env, and [DEPLOY.md](../DEPLOY.md) records them.
**The desktop release builds with the same two hosted values**, written as plain env in
`.github/workflows/desktop-release.yml`, and fails when its bundle does not carry both
(`scripts/check-desktop-bundle-cli.mjs`, #664). Change them in both places together, and keep each
host in the CSP's `connect-src` (`orchestrator/src/csp.rs`).
