# engine/ — Camada 1 (ferramentas oficiais)

Ferramentas da **Zcash Foundation** que o Konclave **orquestra, mas não reimplementa**
(Caminho 1). Nada de criptografia nossa aqui.

- **Não versionamos os binários compilados** no git (ver `.gitignore`); versionamos o
  **pin** em [`versions.lock`](versions.lock) e o script de build.
- Build: compilar da fonte em SHA pinado → emitir para `engine/bin/<target-triple>/` →
  registrar checksum em `versions.lock`.
- Empacotamento: os binários entram como **sidecars** do Tauri, por plataforma.

Ferramentas: `frostd`, `frost-client` (`ZcashFoundation/frost-tools`), `zcash-sign`
(Zcash Signer), `zcash-devtool` (`zcash/zcash-devtool`, suíte PCZT). A crate
`zcash_client_backend` é **linkada** no Orquestrador, não vive aqui.

> Preenchimento dos SHAs e checksums: **Fase 1 (1A)**.
