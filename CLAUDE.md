# CLAUDE.md — Konclave

> **Memória do projeto.** Metodologia GSD: documentação-primeiro. Este arquivo é a
> fonte de contexto de qualquer sessão de trabalho no Konclave. Leia-o antes de codar.
>
> **Fontes de verdade do produto (ler na íntegra, nesta ordem):**
> 1. [docs/CONCEITO_INICIAL.md](docs/CONCEITO_INICIAL.md) — o quê, por quê, decisões fechadas, princípios.
> 2. [docs/UX_E_FLUXOS.md](docs/UX_E_FLUXOS.md) — jornadas, telas, ligações, direção de UX.
> 3. [docs/LOGICA_E_REGRAS.md](docs/LOGICA_E_REGRAS.md) — estados, validações, ciclos de vida (a especificação).
>
> Se algo a fazer contradisser qualquer um dos três, **pare e aponte a contradição**.
> Onde os docs deixam algo "para a logística", é decisão em aberto — pergunte, não invente.

---

## 1. O que é

**Konclave** — o cofre que decide em conjunto. App **desktop local-first** (Tauri:
shell Rust + Next.js/React) que torna usável, para um tesoureiro comum, criar e operar
um **cofre de fundos coletivo, privado e à prova de pessoa-única** sobre a rede Zcash,
usando **assinaturas de limiar (FROST)**. Dois rostos de peso igual: **pagamento
aprovado por quórum** e **folha de pagamento privada** (uma transação Orchard com N
saídas, aprovada uma vez). *Privado por fora, transparente por dentro.*

A lacuna que preenche **não é a criptografia** (o motor oficial já existe e funciona) —
é a **camada de usabilidade**. Hoje usar FROST no Zcash exige CLI, múltiplos terminais
e cópia manual de hex. Konclave é a camada humana por cima das ferramentas da Foundation.

**Contexto:** ZecHub Hackathon 3.0 (2026), tracks FROST + Accounting (peso igual).
Deadline de submissão: **15/jul/2026 UTC**. Desenvolvimento **solo**.

---

## 2. Decisões FECHADAS (não reabrir)

Do [CONCEITO_INICIAL.md §13](docs/CONCEITO_INICIAL.md) + conversa de logística:

| Tema | Decisão |
|---|---|
| Nome | **Konclave** |
| Plataforma | **Desktop local-first via Tauri** (shell Rust + Next.js/React) |
| Integração com o motor | **Caminho 1** (invocar binários CLI oficiais) com **rigor de Caminho 2** |
| Onde mora a chave | **Key share NUNCA sai do dispositivo** (cofre seguro do SO). Entre membros trafega só **material público** |
| Coordenação | **`frostd` oficial** (servidor cego — só vê dados públicos) + fallback QR/copy-paste (stretch) |
| Geração de chave (produto) | **DKG real** (trusted-dealer só como andaime do slice) |
| Rede | **Mainnet, ZEC real, valor mínimo** (~0,01 ZEC). Receber **só em Orchard** |
| Privacidade | **Shielded-first** (Orchard); sem telemetria; segredos nunca em log/disco/URL |
| Escopo | Núcleo intocável + 3 extras promovidos (memo-holerite, prestação de contas, mesa de propostas) |
| Licença | **Dual Apache-2.0 / MIT** |
| Equipe | **Solo** → escopo travado no núcleo; extras só se sobrar fôlego; stretch fora |

Decisões técnicas assumidas na logística:
- **SO de dev:** começar nativo no **Windows**; **WSL2** só se o tooling quebrar.
- **Binários:** compilar da fonte, **pinados por SHA**, vendorizados como submódulos,
  com checksum em `motor/versions.lock` (ver [ADR-0001](docs/adr/0001-decisoes-fechadas.md)).
- **Camada carteira:** **linkar `zcash_client_backend`** no Rust para sync/saldo/plano
  (dado estruturado nativo) — shellar **apenas** os binários FROST/sign.
- **Frontend:** Next.js em **static export** (Tauri serve estático).

---

## 3. Arquitetura — 3 camadas

```
Camada 1 — MOTOR        ferramentas oficiais da Zcash Foundation (NÃO reimplementar cripto)
   frost-client · frostd · zcash-sign · zcash-devtool (PCZT) · zcash_client_backend
        │  (invocação de binários + biblioteca linkada)
        ▼
Camada 2 — ORQUESTRADOR  o backend que construímos (Rust, dentro do src-tauri/)
   cerimônia · assinatura · carteira/sync · propostas (máquina de estados) ·
   validação (ZIP 317) · store (SQLite + keychain) · IPC (comandos Tauri)
        │  (DTOs estruturados via comandos Tauri)
        ▼
Camada 3 — ROSTO         a interface (Next.js/React)
   Abertura · Criar/Entrar cofre · Painel · Pagamento/Folha · Proposta · Histórico · Membros
```

Detalhe completo e mapa de módulos: [docs/ARQUITETURA.md](docs/ARQUITETURA.md).

---

## 4. O Motor — ferramentas oficiais (mapa verificado em 30/jun/2026)

| Ferramenta | Repo | Papel |
|---|---|---|
| `frostd` | `ZcashFoundation/frost-tools` | Servidor de coordenação (cego, só material público) |
| `frost-client` | `ZcashFoundation/frost-tools` | Init de usuário, DKG/trusted-dealer, contatos, cerimônia |
| `zcash-sign` | `ZcashFoundation/frost-tools` (verificado) | `generate --ak` → endereço Orchard + UFVK; `sign` injeta assinatura FROST em plano Ywallet/PCZT |
| `zcash-devtool` | `zcash/zcash-devtool` | Suíte **PCZT** (criação/prova/assinatura/combinação) — envelope da tx e da folha |
| `frost` (lib core) | `ZcashFoundation/frost` | Implementação de referência do FROST |
| `zcash_client_backend` | `zcash/librustzcash` | **Linkada** no Rust: sync UFVK, saldo, construção de plano |

**Chave criptográfica do Zcash:** passar **`-C redpallas`** ativa **Rerandomized FROST**
(compatível com Orchard). O `zcash-sign` lida com o randomizer Orchard. Seguir o tutorial
oficial **sem desvio** no slice — é onde um erro custa fundos reais.

---

## 5. Contexto de rede — NU6.2 / bug Orchard (jun/2026)

Fatos (verificados 30/jun/2026):
- Bug de **soundness** no circuito ZK do Orchard (risco de **falsificação**, NÃO de
  privacidade), presente desde mai/2022, descoberto em 29/mai/2026 por Taylor Hornby
  **usando o Opus 4.8**.
- Corrigido: soft-fork (02/jun, bloco 3.363.426) + **hard-fork NU6.2** (03/jun, bloco
  3.364.600), que **reabilitou o Orchard com o circuito corrigido**. Sem evidência de
  exploração.
- **Status atual:** Orchard vivo e seguro na mainnet. **Buildar contra NU6.2** (tooling
  e lightwalletd cientes do upgrade).
- **Ângulo de narrativa (honesto) para o README:** ferramenta de custódia compartilhada
  confiável logo após o abalo de confiança — exatamente o que o [CONCEITO §8](docs/CONCEITO_INICIAL.md)
  prevê como peso narrativo. O bug foi achado com Opus 4.8; o Konclave é construído com o
  mesmo modelo. Declarar sem exagero.

---

## 6. Princípios inegociáveis (o contrato de qualidade)

**Privacidade por padrão**
1. Shielded-first (Orchard). Destino transparente é exceção explícita e avisada.
2. Minimização de dados. Sem telemetria. Nada coletado/logado/transmitido sem necessidade.
3. Segredos nunca persistem fora do cofre seguro do SO. Nunca em disco texto-plano, log, URL, query string.
4. O servidor de coordenação é **cego** (só material público). Documentado e demonstrável.
5. Memos cifrados (holerite) = dado sensível; só o destinatário/UFVK lê.
6. Transparência interna, privacidade externa.

**Qualidade de código (Caminho 1 com rigor de Caminho 2)**
7. **Saída estruturada, nunca "ler a tela".** Forçar JSON/saída parseável dos binários.
8. **Validação em toda fronteira** (entrada de usuário, saída de binário, dado de rede). Falhas explícitas, nunca silenciosas.
9. **TDD com testes destrutivos** (ver §8).
10. **Estados explícitos.** Máquina de estados de proposta modelada e auditável.
11. **Erros legíveis ao humano** — toda falha vira mensagem clara e acionável na UI.
12. **Documentação-primeiro (GSD).** Este CLAUDE.md e os docs antes do código.

**Honestidade de posicionamento**
13. **Creditar as ferramentas da Foundation** explicitamente.
14. **Distinguir garantia criptográfica de trava de produto** (ex.: quórum-por-valor e
    reserva de saldo são produto, não protocolo) — inclusive na copy.
15. **Não prometer o que não entrega.** Roadmap é roadmap.

**Regras de execução (do prompt de inicialização)**
- **Sem coautoria.** Nada de "Co-authored-by" / "Generated with Claude Code" em commits,
  PRs, código ou README. Commits saem limpos, no nome do dono.
- Licença dual Apache-2.0 / MIT em todo o repo.

---

## 7. Princípio de UX que governa o Rosto

**Esconder a criptografia, expor a confiança.** O usuário nunca vê "FROST", "DKG",
"SIGHASH" ou "nonce" — vê cofre, membros, aprovação, pagamento. Toda ação que move fundos
tem **preview + confirmação explícita**; nunca um clique único dispara dinheiro. Copy
honesta e ativa ("Propor pagamento" → "Aprovar" → "Enviado"). Estados sempre visíveis.

---

## 8. Suíte de testes destrutivos (nasce na Fase 3)

O código nasce para passar nestes cenários de falha:
- Quórum insuficiente.
- Share corrompida / ausente.
- `frostd` offline.
- Transação malformada.
- **Endereço Sapling em vez de Orchard** (risco de fundos travados).
- Saldo insuficiente.
- Proposta expirada.
- Reconciliação multi-dispositivo (cache local diverge do on-chain → on-chain vence).

> Testar multi-membro solo = rodar N identidades `frost-client` contra um `frostd`.

---

## 9. Roadmap de fases

Plano completo: [docs/ROADMAP.md](docs/ROADMAP.md).

| Fase | Objetivo | Portão |
|---|---|---|
| 0 — Fundação & Docs | Repo, licença, CLAUDE.md, esqueleto, reality-check | — |
| 1 — Vertical Slice (mainnet) | 1ª transação FROST real confirmada via CLI | 🔴 Gate 1 |
| 2 — Migração para DKG real | Cofre por DKG (chave nunca remontada) | — |
| 3 — Orquestrador (backend) | Máquina de estados, validação, folha, TDD destrutivo | — |
| 4 — Rosto (design + telas) | Token system + telas contra mock | — |
| 5 — Integração | Núcleo inteiro pela UI na mainnet | 🔴 Gate 2 |
| 6 — Extras de impacto | Memo-holerite, prestação de contas, mesa de propostas | — |
| 7 — Entrega | README unicórnio, vídeo, diagrama, submissão | 🏁 |

---

## 10. Parâmetros de logística

| Parâmetro | Valor | Status |
|---|---|---|
| Financiamento da demo | ~0,01 ZEC (≈ $4 a ~$395/ZEC em 30/jun/2026) | decidido |
| Prazo de expiração de proposta | 72h | placeholder configurável |
| Limite de linhas por folha | função do tamanho máx. de tx | a fixar na Fase 3 |
| Colunas do CSV da folha | rótulo, endereço, valor, memo | a fixar na Fase 3 |
| Hospedagem do `frostd` na demo | localhost (slice) → VPS se demo multi-máquina | a decidir |

---

## 11. Estado atual

**Fase 1 (Vertical Slice) — passo 1A concluído.**
- **Ambiente:** WSL2/Ubuntu (Windows nativo estava sem toolchain C/C++). rustc 1.96.1,
  clang 21, cmake 4.2, protoc 3.21. Rede OK.
- **Motor compilado:** `frost-tools` clonado e buildado; os TRÊS binários (`frostd`,
  `frost-client`, `zcash-sign`) vivem **no mesmo repo**, pinados em
  [motor/versions.lock](motor/versions.lock) (rev `3d2985c`). Crypto confirmada:
  `frost-rerandomized 2.1.0`, `reddsa`, `orchard 0.11.0` (fork conradoplg), `pczt 0.5.0`.
- **Interfaces verificadas:** `-C redpallas` (após `--`) ativa Rerandomized FROST;
  `--cli` dá saída JSON; `trusted-dealer` aceita N configs (multi-membro numa máquina);
  `zcash-sign generate --ak` → Orchard+UFVK; `zcash-sign sign` aceita plano Ywallet/PCZT.
- **Tutorial de referência:** Ywallet demo (`frost.zfnd.org/zcash/ywallet-demo.html`).
- **⚠️ Achado de segurança:** `frost-client init` guarda as shares em **texto claro** em
  `~/.local/frost/credentials.toml`. Cifrar em repouso / keychain no produto (Fase 3).

**Próximo (passo 1B):** gerar chave via `trusted-dealer -C redpallas` (andaime) →
`zcash-sign generate --ak` → endereço **Orchard** + UFVK. Depois 1C (financiar) e 1D
(plano de tx → cerimônia → broadcast).
