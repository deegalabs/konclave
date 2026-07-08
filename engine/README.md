# engine/ — Layer 1 (official tools)

**Zcash Foundation** tools that Konclave **orchestrates but does not reimplement**
(Path 1). No cryptography of ours lives here.

- **We do not version the compiled binaries** in git (see `.gitignore`); we version the
  **pin** in [`versions.lock`](versions.lock) and the build script.
- Build: compile from source at a pinned SHA → emit to `engine/bin/<target-triple>/` →
  record the checksum in `versions.lock`.
- Packaging: the binaries ship as Tauri **sidecars**, per platform.

Tools: `frostd`, `frost-client` (`ZcashFoundation/frost-tools`), `zcash-sign`
(Zcash Signer), `zcash-devtool` (`zcash/zcash-devtool`, PCZT suite). The
`zcash_client_backend` crate is **linked** into the Orchestrator, it does not live here.

> Filling in the SHAs and checksums: **Phase 1 (1A)**.
