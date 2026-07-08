# Konclave — Arquitetura

> Documento de arquitetura (GSD). Companion de [CLAUDE.md](../CLAUDE.md) e dos 3 docs-fonte.

## 1. Visão de três camadas

```
┌─────────────────────────────────────────────────────────────────────┐
│ Camada 3 — ROSTO (Next.js/React, static export servido pelo Tauri)    │
│   Abertura · Criar/Entrar cofre · Painel · Pagamento/Folha ·          │
│   Proposta (aprovar/recusar) · Enviado · Histórico · Membros          │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │  comandos Tauri (DTOs estruturados)
┌───────────────────────────────▼─────────────────────────────────────┐
│ Camada 2 — ORQUESTRADOR (Rust, dentro de src-tauri/ — o que construímos)│
│   ceremony · signing · wallet · proposals · validation · store · ipc  │
└───────────────────────────────┬─────────────────────────────────────┘
        invocação de binários (saída estruturada)  │  biblioteca linkada
┌───────────────────────────────▼─────────────────────────────────────┐
│ Camada 1 — MOTOR (ferramentas oficiais da Foundation — não reimplementar)│
│   frostd · frost-client · zcash-sign · zcash-devtool(PCZT) ·          │
│   zcash_client_backend (linkada)                                      │
└──────────────────────────────────────────────────────────────────────┘
                                 │
                    rede: frostd (coordenação) · lightwalletd · mainnet Zcash (NU6.2)
```

## 2. O que viaja vs. o que fica (modelo de confiança)

| Fica **só no dispositivo** (nunca sai) | **Viaja pela rede** (público) |
|---|---|
| Key share, seed, segredos | Pacotes de round do DKG, commitments de nonce |
| Memos decifrados | Assinaturas parciais |
| O ato de assinar | A transação final (vai à mainnet) |

O `frostd` é um **carteiro cego**: transporta envelopes públicos, não abre nenhum.
Comprometê-lo não revela segredos nem permite gastar — no máximo atrapalha a coordenação
(daí o fallback QR/copy-paste).

## 3. Fontes de verdade

- **On-chain (mainnet):** verdade final sobre fundos. **On-chain vence sempre.**
- **Estado local (por dispositivo):** share, cofres, rótulos, cache, propostas em andamento.
- **`frostd`:** transporte efêmero de material **público**; não é fonte de verdade.

## 4. Mapa de módulos do Orquestrador (`src-tauri/`)

| Módulo | Responsabilidade |
|---|---|
| `ceremony` | DKG (e trusted-dealer no slice) via `frost-client` + `frostd` |
| `signing` | Rodadas de assinatura de proposta; **Rerandomized FROST** (`-C redpallas`) via `zcash-sign` |
| `wallet` | Sync via UFVK, saldo/histórico, construção de plano (PCZT) — `zcash_client_backend` linkado |
| `proposals` | **Máquina de estados** (LOGICA §6), reserva de saldo, expiração, reconciliação |
| `validation` | Endereço/valor/memo/taxa (ZIP 317); falhas explícitas em toda fronteira |
| `store` | Estado local em SQLite + share no keychain do SO |
| `ipc` | Comandos Tauri expostos ao Rosto; DTOs tipados |

## 5. Máquina de estados da Proposta (LOGICA §6)

```
rascunho ──propor──> aguardando ──quórum──> pronta ──broadcast──> enviada ──confirma──> confirmada
   │                    │
   │                    ├──recusa inviabiliza quórum──> recusada
   │                    ├──expira──> expirada
   │                    └──cancela (só proponente)──> cancelada
   descartar
```
- Proponente conta como 1ª aprovação. Quórum = `t`. Aprovação idempotente.
- Inalcançabilidade: se recusas > (n − t) → `recusada` automático.
- Reserva de saldo enquanto a proposta vive (trava **de produto**, não de protocolo).
- Folha = **uma** transação com N saídas → **uma** proposta → **uma** rodada de aprovações.

## 6. Fluxo de uma transação (slice → produto)

1. `frost-client` init de cada membro → contatos.
2. **DKG** via `frostd` (produto) / trusted-dealer (slice) → group key, shares locais.
3. `zcash-sign generate --ak` → endereço **Orchard** + UFVK.
4. Financiamento na mainnet (Orchard) → `wallet` sincroniza via UFVK.
5. Propor: `wallet` monta plano → **PCZT** → `zcash-sign` extrai o que assinar (+ randomizer).
6. Cerimônia de assinatura (`-C redpallas`) coordenada por `frostd` → assinatura FROST.
7. `zcash-sign` injeta a assinatura no PCZT → tx assinada → broadcast → confirmação.

## 7. Empacotamento

- **Tauri sidecars:** os binários do Motor entram empacotados por target-triple.
- **Dev:** Windows nativo primeiro; WSL2 como fallback se o tooling exigir Linux.
- **Build determinístico:** `engine/` compila da fonte em SHA pinado; checksum em
  `engine/versions.lock`.
