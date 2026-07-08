# Konclave

> **The vault that decides together.** No payment goes out without quorum.
> Private on the outside, transparent on the inside.

Konclave is a **local-first desktop app** that makes it usable, for ordinary people, to
create and operate a **collective, private fund vault** on the **Zcash** network, using
threshold signatures (**FROST**). Pay by quorum or run an entire **private payroll** in a
single collectively-approved envelope — without touching a command line, and without
leaking anything to the public blockchain.

The cryptography already exists and comes from the official **Zcash Foundation** tools.
What was missing was the **human layer** — that is what Konclave delivers.

> ⚠️ **Status:** under construction (ZecHub Hackathon 3.0, 2026). This README is
> provisional; the full showcase, with a mainnet demo and a real transaction link, comes
> with the final delivery.

## Documentation

- [CLAUDE.md](CLAUDE.md) — project memory and context.
- [docs/CONCEITO_INICIAL.md](docs/CONCEITO_INICIAL.md) — the what and the why.
- [docs/UX_E_FLUXOS.md](docs/UX_E_FLUXOS.md) — journeys and screens.
- [docs/LOGICA_E_REGRAS.md](docs/LOGICA_E_REGRAS.md) — states and rules.
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md) — the three layers.
- [docs/ROADMAP.md](docs/ROADMAP.md) — build plan.

## How it works (in one sentence)

The vault key is split among the members; **no single piece moves funds** and the whole
key is **never reconstituted**. The approvals produce a single signature that, from the
outside, looks like a normal one-person transaction. Your part of the key **never leaves
your device**.

## Credit

Built on top of the **Zcash Foundation** tools: `frostd`, `frost-client`
([frost-tools](https://github.com/ZcashFoundation/frost-tools)), the Zcash Signer, and
[zcash-devtool](https://github.com/zcash/zcash-devtool). Konclave does not reimplement
cryptography — it adds the usability layer on top.

## License

Dual **Apache-2.0** / **MIT**, at the user's choice (mirrors the Rust/Zcash ecosystem).
See [LICENSE-APACHE](LICENSE-APACHE) and [LICENSE-MIT](LICENSE-MIT).
