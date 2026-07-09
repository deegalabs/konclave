# Contributing to Konclave

Thanks for your interest. Konclave is a local-first desktop app that puts a usable human
layer over the Zcash Foundation's FROST threshold-signature tools. It moves real funds, so
correctness, privacy, and honesty matter more than speed.

## Ground rules

- **Read the context first:** `CLAUDE.md` and `docs/` (concept, UX, logic-and-rules,
  architecture, ADRs). If a change contradicts them, stop and raise it.
- **Hide the cryptography, expose the trust.** Users see vault / members / approve / pay —
  never FROST / DKG / SIGHASH / nonce. Every fund-moving action has preview + explicit
  confirmation.
- **Don't reimplement cryptography.** We orchestrate the official Foundation tools and
  credit them.
- **Privacy by default.** No telemetry. Secrets never touch disk in plaintext, logs, URLs,
  or query strings. The coordination server stays blind.

## Language

- Code, comments, identifiers, commits, and docs: **English.**
- UI copy: **internationalized** — English keys in code, translations in the PT-BR locale.
  No hardcoded user-facing strings.

## Workflow

1. Branch off `main`. One coherent change per PR.
2. Commits: `type(scope): description` (e.g. `fix(ui): guard the no-expiry sentinel`).
   **No AI co-author trailer.**
3. Fill in the PR checklist.

## Verify before finishing

```bash
# Rust (orchestrator + konclave-signer)
cargo fmt --manifest-path orchestrator/Cargo.toml -- --check
cargo clippy --manifest-path orchestrator/Cargo.toml --all-targets -- -D warnings
cargo test  --manifest-path orchestrator/Cargo.toml

# Frontend
cd ui && npm run lint && npm run build
```

## Tests

Follow TDD, especially for the destructive suite (insufficient quorum, corrupt/missing
share, `frostd` offline, malformed tx, Sapling-instead-of-Orchard, insufficient balance,
expired proposal, multi-device reconciliation). Fund-critical code in `konclave-signer/`
must be tested against known vectors.

## Security

See `SECURITY.md`. Report vulnerabilities privately, never in a public issue or PR. If your
change touches the FROST signer, PCZT, the loopback bridge, or key custody, note the
security impact in the PR.
