# src-tauri/ — Camada 2 (Orquestrador) + shell Tauri

O backend que **construímos** (Rust), dentro do shell Tauri. Conversa com o Motor por
invocação de binários (saída estruturada) e pela crate `zcash_client_backend` linkada.
Expõe comandos Tauri (DTOs tipados) ao Rosto.

## Mapa de módulos (a criar a partir da Fase 3)

| Módulo | Responsabilidade |
|---|---|
| `ceremony` | DKG (trusted-dealer no slice) via `frost-client` + `frostd` |
| `signing` | Assinatura de proposta; Rerandomized FROST (`-C redpallas`) via `zcash-sign` |
| `wallet` | Sync UFVK, saldo/histórico, plano de tx (PCZT) — `zcash_client_backend` |
| `proposals` | Máquina de estados, reserva de saldo, expiração, reconciliação |
| `validation` | Endereço/valor/memo/taxa (ZIP 317); falhas explícitas |
| `store` | SQLite (estado local) + keychain do SO (share) |
| `ipc` | Comandos Tauri → Rosto |

Princípios: saída estruturada (nunca "ler a tela"), validação em toda fronteira, estados
explícitos, segredos nunca em log/disco/URL. Detalhe: [docs/ARQUITETURA.md](../docs/ARQUITETURA.md).
