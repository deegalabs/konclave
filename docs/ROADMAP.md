# Konclave — Roadmap de Construção

> Plano de fases aprovado. Calibrado para **solo, ~15 dias** (início 30/jun/2026 →
> deadline 15/jul/2026 UTC), **vertical slice primeiro**, escopo travado no núcleo.

## Princípios do cronograma
- **O risco está na Fase 1** (cripto → broadcast). Vem primeiro e é o portão existencial.
- **Solo = disciplina de escopo.** Núcleo é compromisso firme; extras só se o núcleo fechar.
- **Documentação e segurança são transversais** (dia 1 ao 15), não fases.

## Visão geral

| Fase | Dias | Objetivo | Portão |
|---|---|---|---|
| 0 — Fundação & Docs | 1 | Repo, licença, CLAUDE.md, esqueleto, reality-check | — |
| 1 — Vertical Slice (mainnet) | 1–4 | 1ª transação FROST real confirmada via CLI | 🔴 Gate 1 |
| 2 — Migração para DKG real | 4–5 | Cofre por DKG (chave nunca remontada) | — |
| 3 — Orquestrador (backend) | 5–9 | Máquina de estados, validação, folha, TDD destrutivo | — |
| 4 — Rosto (design + telas) | 6–10 (paralela) | Token system + telas contra mock | — |
| 5 — Integração | 9–11 | Núcleo inteiro pela UI na mainnet | 🔴 Gate 2 |
| 6 — Extras de impacto | 11–13 | Memo-holerite, prestação de contas, mesa de propostas | — |
| 7 — Entrega | 13–15 | README unicórnio, vídeo, diagrama, submissão | 🏁 |

---

## Fase 0 — Fundação & Documentação (GSD) — Dia 1
**Objetivo:** terreno e memória do projeto antes de qualquer código.
**Entregáveis:** esqueleto (`motor/`, `src-tauri/`, `rosto/`, `docs/`, `tests/`); licença
dual; `CLAUDE.md`; docs-fonte em `docs/`; `motor/versions.lock` (esqueleto); ADR-0001;
`.gitignore`; este roadmap.
**Reality-check:** repos oficiais localizados, tutorial de referência confirmado, status
Orchard pós-NU6.2 verificado (Orchard vivo e seguro na mainnet).
**Pronto quando:** repo navegável; CLAUDE.md é a fonte de contexto.

## Fase 1 — Vertical Slice na Mainnet — Dias 1–4 🔴
**Objetivo:** uma transação FROST real, confirmada na mainnet, mesmo feia (via CLI).
- **1A — Toolchain:** compilar os binários do `frost-tools` + `zcash-sign` da fonte
  (Windows nativo → WSL2 se quebrar), pinar SHA + checksum, **verificar interfaces
  (`--json`?)**, **testar acesso de rede** (clonar repo + alcançar lightwalletd NU6.2).
- **1B — Chave:** material via trusted-dealer (andaime) → `zcash-sign generate --ak` →
  **endereço Orchard + UFVK**.
- **1C — Fundos:** financiar ~0,01 ZEC no endereço **Orchard** → sync via UFVK → ler saldo.
- **1D — Gasto:** plano de tx (PCZT) → cerimônia de assinatura (`-C redpallas`) via
  `frostd` → tx assinada → broadcast → **confirmação no explorador**.
> **🔴 GATE 1 (go/no-go):** transação verificável on-chain. Se não fechar, replanejar
> antes de gastar tempo em UX.

## Fase 2 — Migração para DKG real — Dias 4–5
**Objetivo:** trocar trusted-dealer por **DKG real** via `frostd`.
**Pronto quando:** cofre nasce por DKG, chave nunca remontada, transação sai por cima.

## Fase 3 — Orquestrador — Dias 5–9
**Objetivo:** envelopar cada passo CLI como comando Rust com **DTO estruturado**.
**Módulos:** `ceremony`, `signing`, `wallet`, `proposals` (máquina de estados §6),
`validation` (ZIP 317), `store` (SQLite + keychain), `ipc`.
**Inclui:** reserva de saldo, expiração, reconciliação, lógica da folha (N saídas).
**Pronto quando:** núcleo operável por comandos + **toda a suíte destrutiva passando**.

## Fase 4 — Rosto — Dias 6–10 (paralela à Fase 3)
- **4A — Token system** (skill `frontend-design`): paleta, tipografia, elemento-assinatura
  derivado do mundo Zcash/Orchard, tratamento próprio pro "ocultar valor". Validado antes
  de virar tela.
- **4B — Telas** contra mock: Abertura → Criar/Entrar → Painel → Pagamento/Folha →
  Proposta → Enviado → Histórico, Membros, Propostas pendentes.
**Pronto quando:** telas navegáveis contra mock; acessibilidade de piso.

## Fase 5 — Integração — Dias 9–11 🔴
**Objetivo:** mock → comandos reais; núcleo inteiro funciona **pela UI** na mainnet.
**Inclui:** estados de erro reais (frostd offline, saldo insuficiente, endereço Sapling).
> **🔴 GATE 2:** demo do núcleo ponta a ponta pela interface. Se atrasar, corta Fase 6.

## Fase 6 — Extras de impacto (se sobrar fôlego) — Dias 11–13
Em ordem de impacto: **memo-holerite** → **prestação de contas via UFVK** (quem
propôs/aprovou + export CSV) → **mesa de propostas pendentes** (com expiração).
**Pronto quando:** o que der entra polido; o que não der fica honesto no roadmap do README.

## Fase 7 — Entrega — Dias 13–15 🏁
**Entregáveis:** README padrão unicórnio (hero, "por que existe", demo GIF + link de tx
real, diagrama 3 camadas, crédito à Foundation, quickstart, modelo de confiança, roadmap
honesto, licença); vídeo demo na mainnet; vídeo backup; checklist de submissão.
**Pronto quando:** submetido antes de 15/jul/2026 UTC.

---

## Portões go/no-go
- **Gate 1 (fim Fase 1):** transação FROST real na mainnet. Risco existencial.
- **Gate 2 (fim Fase 5):** núcleo funcional pela UI. Se falhar, corta extras e foca polir.

## Folga
Slice fechado até dia ~4–5; núcleo até ~11; dias 12–15 para entrega **e buffer**. Se o
slice escorregar, a Fase 6 é a válvula de escape — nunca o núcleo.
