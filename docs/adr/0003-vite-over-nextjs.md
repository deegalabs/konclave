# ADR-0003 — Vite + React instead of Next.js for the UI

- **Status:** accepted
- **Date:** 2026-07-01
- **Context:** [ADR-0001](0001-closed-decisions.md) set "Frontend: Next.js as a static
  export" as a lower-consequence decision, to be confirmed during execution. On starting
  Phase 5 (the real app), the choice was reassessed.

## Decision

Use **Vite + React + TypeScript** (not Next.js) for the UI.

## Why

- Konclave is a **Tauri desktop app**, not a website. There is no SSR, no server routes,
  no SEO, no edge — all of Next.js's value (the server runtime) is **inapplicable**.
- What Tauri consumes is a **static bundle** (`file://`). Vite delivers this natively, with
  a lighter and faster build; Next.js would require `output: export` and still carry
  unnecessary weight.
- Vite is the **default and recommended** path for Tauri frontends.

## Consequences

- Simple structure: `ui/` = the Vite app; `ui/design/` = design system + prototypes;
  `ui/src/lacre.css` = the applied design system.
- Building for `file://` requires `base: './'` (relative) in `vite.config.ts` — already
  configured. (Note: ES modules do not load via `file://` outside Tauri due to CORS; for
  preview use `vite preview` or the dev flag.)
- No loss: the design (tokens + components in `lacre.css`) is framework-independent.
