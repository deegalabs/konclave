# tests/

**The unit + destructive test suites live inside the crates**, next to the code they
exercise (Rust `#[cfg(test)]` modules), not in this directory:

- `orchestrator/src/*.rs`: the destructive suite (129 tests): money, the proposal state
  machine, validation, store, the loopback bridge (`handle`/`handle_secured`), sealing,
  payroll, DKG, send.
- `konclave-signer/src/main.rs`: the FROST↔PCZT bridge (crypto-vector tests: in progress).
- `ui/`: frontend tests are a follow-up (a Vitest runner is not yet wired).

Run them with:

```bash
cargo test --manifest-path orchestrator/Cargo.toml
cargo test --manifest-path konclave-signer/Cargo.toml
```

## Reserved for the console simulation harness

This directory is reserved for the **end-to-end console simulation** that drives each use
case (create vault → receive → propose → approve → sign → send → account) and asserts the
flow, first in demo / dry-run mode (no funds), then against the real engine once the
motor binaries are built. See the destructive scenarios that must pass in
[docs/LOGICA_E_REGRAS.md](../docs/LOGICA_E_REGRAS.md) §6 and CLAUDE.md §8.
