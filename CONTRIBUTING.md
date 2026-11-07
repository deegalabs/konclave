# Contributing to Konclave

Thanks for your interest. Konclave is a local-first desktop app that puts a usable human
layer over the Zcash Foundation's FROST threshold-signature tools. It moves real funds, so
correctness, privacy, and honesty matter more than speed.

## Ground rules

- **Read the context first:** `CLAUDE.md` and `docs/` (concept, UX, logic-and-rules,
  architecture, ADRs). If a change contradicts them, stop and raise it.
- **Hide the cryptography, expose the trust.** Users see vault / members / approve / pay,
  never FROST / DKG / SIGHASH / nonce. Every fund-moving action has a preview and explicit
  confirmation.
- **Don't reimplement cryptography.** We orchestrate the official Foundation tools and
  credit them.
- **Privacy by default.** No telemetry. Secrets never touch disk in plaintext, logs, URLs,
  or query strings. The coordination server stays blind.

## Language

- Code, comments, identifiers, commits, and docs: **English.**
- UI copy: **internationalized**, English keys in code, translations in the PT-BR locale.
  No hardcoded user-facing strings.

## Workflow

1. Branch off `staging`; PRs target `staging`, and `main` takes releases only. One coherent change
   per PR.
2. Commits: Conventional Commits in English, `type(scope): summary` (e.g.
   `fix(ui): guard the no-expiry sentinel (#123)`). The summary is lower case, with no final
   period, and says what changes; an optional body says why.
   If an AI assistant helped, add the trailer described in
   [AI-assisted contributions](#ai-assisted-contributions).
   - **Types:** `feat`, `fix`, `security`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`,
     `chore`, `revert`. `security` is this project's own type: its changelog entry goes under
     `Security`.
   - **Scope:** the component that changes (`ui`, `signer`, `wasm`, `helper`, `relay`,
     `engine`, `roadmap`, `docs`, ...), never an issue number. The issue goes at the end of the
     summary: `(#610)`.
   - **A version cut** is `chore(release): vX.Y.Z`.
3. Fill in the PR checklist.

## AI-assisted contributions

Konclave is built with AI assistance (Claude Code), and you are welcome to use an AI assistant
too. I do not want to make it harder; I want it said, so a reviewer knows what they are reading.

- **Commit trailer.** A commit made with an AI assistant ends with a `Co-Authored-By:` line that
  names the assistant, generically and without a model version:

  ```
  Co-Authored-By: Claude <noreply@anthropic.com>
  ```

  Use the equivalent line for another assistant.
- **No session link.** Never add a link to the assistant's session (a `Claude-Session` trailer, a
  claude.ai URL) to a commit, PR or comment. The committed
  [`.claude/settings.json`](.claude/settings.json) turns it off for Claude Code.
- **The PR says so** on the "AI disclosure" line of the template, with the tool and roughly what
  it did.
- **You are the author.** You read, understand and stand behind every line, as if you had typed it.
  "The assistant wrote it" is not an answer in review.

This applies from the merge of the PR that set it (decision D91, 2026-11-05); earlier history is
not rewritten. Projects differ here: librustzcash, the ZIPs and Zallet also ask for a
`Co-Authored-By:` trailer, while Zebra asks for disclosure in the PR description and no trailer.
This repository follows its own rule. It is a prose rule for now; a CI check may come later.

## Verify before finishing

```bash
# Rust (orchestrator + konclave-signer)
cargo fmt --manifest-path orchestrator/Cargo.toml -- --check
cargo clippy --manifest-path orchestrator/Cargo.toml --all-targets -- -D warnings
cargo test  --manifest-path orchestrator/Cargo.toml

# Frontend. The repository is a pnpm workspace: run `pnpm install` once at the root.
# `build` type-checks and bundles, and it does not run the tests, so run `test` as well.
pnpm -C ui run lint
pnpm -C ui run test
pnpm -C ui run build
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
