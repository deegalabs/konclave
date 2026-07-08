<!-- Keep PRs to one coherent change. Title format: type(scope): description -->

## What & why

<!-- What does this change and why. Link the issue if any. -->

## Verify-before-finishing checklist

- [ ] `cargo fmt --check` + `cargo clippy -- -D warnings` pass (orquestrador, konclave-signer)
- [ ] `cargo test` passes (the destructive suite in `orquestrador/`)
- [ ] `rosto/`: `npm run lint` + `npm run build` (tsc + vite) pass
- [ ] No secret, key share, seed, or passphrase in code, logs, URLs, or query strings
- [ ] Every fund-moving path keeps preview + explicit confirmation
- [ ] If this touches the FROST signer, PCZT, or the loopback bridge: security impact considered and, if relevant, logged in `SECURITY_AUDIT.md`
- [ ] User-facing strings go through i18n (English keys + PT-BR locale); no hardcoded UI copy
- [ ] Docs/comments in English; commit is `type(scope): description`, no AI co-author trailer
