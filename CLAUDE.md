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
shell Rust + Vite/React) que torna usável, para um tesoureiro comum, criar e operar
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
| Plataforma | **Desktop local-first via Tauri** (shell Rust + Vite/React) |
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
  com checksum em `engine/versions.lock` (ver [ADR-0001](docs/adr/0001-decisoes-fechadas.md)).
- **Camada carteira:** **linkar `zcash_client_backend`** no Rust para sync/saldo/plano
  (dado estruturado nativo) — shellar **apenas** os binários FROST/sign.
- **Frontend:** **Vite + React** em bundle estático ([ADR-0003](docs/adr/0003-vite-over-nextjs.md)
  revisou o Next.js originalmente cogitado — inaplicável a um app local-first sem servidor).

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
Camada 3 — ROSTO         a interface (Vite/React)
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

**Fase 1 (Vertical Slice) — ✅ GATE 1 CONQUISTADO (2026-07-01).**
Primeira transação FROST 2-de-3 do Konclave na **mainnet**:
txid `f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360` (bloco 3.396.616).
Fluxo completo e lições em [docs/VERTICAL_SLICE.md](docs/VERTICAL_SLICE.md).

- **Ambiente:** WSL2/Ubuntu (Windows sem toolchain C/C++). rustc 1.96.1, clang 21, cmake, protoc.
- **Motor:** `frost-tools` @ `3d2985c` (frostd/frost-client/zcash-sign) + `zcash-devtool`
  @ `91ba536` (carteira/sync/PCZT/broadcast), compilados. Pins em
  [engine/versions.lock](engine/versions.lock).
- **A ponte (`konclave-signer`):** construída e provada — resolve o **vão de integração**
  entre frost-tools (pczt 0.5) e zcash-devtool (pczt 0.7). É o **nascimento do Orquestrador**.
  Ver [ADR-0002](docs/adr/0002-pczt-frost-bridge.md).
- **Fluxo provado:** trusted-dealer 2-de-3 (redpallas) → endereço Orchard + UFVK →
  financiado com ZEC real → sync → PCZT create/prove → `konclave-signer extract` →
  cerimônia FROST via `frostd` (TLS) → `konclave-signer inject` → `pczt send` → mainnet.
- **⚠️ Débito de segurança:** `frost-client` guarda shares em **texto claro** em
  `~/.local/frost/credentials.toml` → cifrar/keychain na Fase 3.

**Fase 2 (DKG real) — ✅ CONCLUÍDA (2026-07-01).** Cofre gerado por **Distributed Key
Generation** (3 participantes via `frostd`), a chave **nunca remontada**. Grupo DKG:
`0ab93649e62dd68858ed57af1e7f7743cc2a4912110d7fb547d35c8c8494ee34` → endereço Orchard
`u1t2qphc0v…836yl2`. Shares validadas por cerimônia de assinatura 2-de-3. Fluxo do DKG
em [docs/VERTICAL_SLICE.md](docs/VERTICAL_SLICE.md).

**Fase 3 (Orquestrador) — 3.1–3.3 ✅ CONCLUÍDAS.** Crate `orchestrator/` (Rust, TDD),
**51 testes destrutivos verdes**:
- **3.1 Domínio:** `money` (Zatoshis checado), `proposal` (máquina de estados §6),
  `validation` (ZIP 317, memo, folha).
- **3.2 Orquestração:** `tools`/`wallet`/`signer`/`pczt`/`ceremony` — embrulham os
  binários com saída estruturada (parsers testados contra saída real do slice).
- **3.3 Segurança + store:** `secrets` (XChaCha20-Poly1305 sela as shares em repouso;
  keychain via trait; arquivo efêmero 0600). **Quitado no 5-E**: o caminho vivo da
  cerimônia passou a usar configs `frost-client` **selados**, desselados só para arquivos
  efêmeros 0600 em tmpfs durante a assinatura — nada de share em texto claro no disco.
  `store` (SQLite embutido: cofres, propostas, votos).

- **3.4 Folha:** `payroll` (plano de N saídas, `import_csv`, validação agregada) +
  `money::from_zec_str`. Os **comandos Tauri (IPC)** ficam para a **integração
  (Fase 5)**, quando a casca Tauri existir — construí-los sem o frontend seria stub
  não-testável.

**Estado do backend:** `orchestrator/` completo no domínio + orquestração + segurança +
store + folha, **59 testes destrutivos verdes**. Falta apenas a casca Tauri + IPC (na
integração). Build: WSL2, `CARGO_TARGET_DIR` fora do repo (código versionado; `ktarget`
só no WSL).

**Fase 4 (Rosto/design) — ✅ CONCLUÍDA.** Design system **"Lacre"** (papel arquivístico,
oxblood, Archivo + mono, tarja de sigilo, selo de cera) em `ui/src/lacre.css`; app
navegável em Vite + React + TS (HashRouter): Painel, Abertura, Cerimônia, Novo Pagamento,
Nova Folha, Proposta, Enviado, Razão. Ver [ADR-0003](docs/adr/0003-vite-over-nextjs.md).

**Fase 5c (integração UI ↔ núcleo) — ✅ pivô concluído (2026-07-01).**
- **Go/no-go do WSLg falhou:** janela GTK/Tauri não renderiza nesta máquina (ícone na
  barra, sem conteúdo; nem render por software resolve). Registrado em
  [ADR-0004](docs/adr/0004-ponte-http-local.md).
- **Pivô:** em vez de IPC Tauri, o Orquestrador expõe uma **ponte HTTP em loopback**
  (`konclave serve`, bin novo no crate; `src/server.rs`, dep `tiny_http`) que serve o
  bundle do Rosto **+ API `/api/*`** ligada ao núcleo testado. Bind **só em 127.0.0.1**.
- **Provado ponta a ponta:** navegador do **Windows** → servidor no **WSL** via
  `localhost:4762` (health, vault 2-de-3, propostas, estáticos). **69 testes verdes**
  (10 novos de `server::handle`, incluindo destrutivos: 405/404-json/403-traversal/502).
- **Rosto ligado ao vivo:** `ui/src/api.ts` (cliente com fallback para mock) + proxy
  Vite `/api`; Painel mostra cofre/propostas reais com selo de "● ao vivo".
- **Launcher:** `scripts/konclave.ps1` (Windows) + `scripts/_serve.sh` (WSL) — builda,
  sobe a ponte e abre o navegador.
- **Empacotamento Tauri (binário único desktop):** movido para **roadmap** (ADR-0004) —
  a garantia local-first não muda, só a forma de entrega.

**Fase 5d (fluxo de escrita ponta a ponta pela UI) — ✅ CONCLUÍDA (2026-07-01).**
Trilha "propor → aprovar → assinar → enviar" inteira pela aplicação:
- **Saldo ao vivo:** `/api/balance` ligado à carteira do slice (re-sincronizada; 90000
  zat gastáveis). Painel mostra saldo real.
- **Criar/aprovar/recusar:** `POST /api/proposals` (validação de fronteira + guarda de
  gasto contra saldo real) e `POST /api/proposals/{id}/approve|refuse` (máquina de
  estados autoritativa; 409 em voto conflitante/fora de estado). Telas `NovoPagamento` e
  `Proposta` ligadas ao vivo. **88 testes verdes.**
- **Cerimônia + envio:** `orchestrator/src/send.rs` encadeia os wrappers testados
  (pczt create/prove/send · konclave-signer extract/inject · frostd coordenador+
  participantes concorrentes) num fluxo Ready→Sent, com **dry-run** que assina sem
  transmitir. Exposto em `POST /api/proposals/{id}/send` (habilitado por `--ceremony`).
- **🏁 Primeira tx de mainnet dirigida pela aplicação (não mais CLI manual):**
  txid `43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572` — pagamento
  2-de-3 aprovado por quórum, assinado por cerimônia FROST server-side e transmitido, tudo
  pela ponte HTTP. A chave **nunca foi remontada**.

**Trilha contábil — ✅ funcional (2026-07-01).** `store::list_all_proposals` (razão
completo, estados terminais inclusos); `GET /api/ledger` (JSON) + `GET /api/ledger.csv`
(**export itemizado**: pagamento único = 1 lançamento; folha de N = **N lançamentos**, um
por beneficiário, com escaping RFC-4180). Tela `Razão` ao vivo com export CSV + imprimir/
PDF. Redesenho contábil (documento / competência / rascunho / beneficiário-entidade)
planejado em [docs/REDESENHO_FOLHA.md](docs/REDESENHO_FOLHA.md).

**Fase 5 — coerência, folha e robustez (2026-07-01):**
- **5-A** cofre real (o app deixou de mostrar um seed falso; endereço/grupo agora = os da
  carteira e da cerimônia).
- **5-B** folha pela UI: **propor + aprovar** (documento editável, competência, rascunho
  local); **motor multi-saída** (`konclave-signer build-payroll`, que linka
  `zcash_client_backend` — §2) + **cerimônia multi-assinatura** (uma assinatura FROST por
  spend real) — a folha **assina de verdade**.
- **5-C** estados de erro: avisos de endereço, **erros técnicos → mensagens humanas** (§6.11),
  **expiração** de proposta (§6.3).
- **101 testes verdes.**

**Fase 5 — identidade e segurança (2026-07-01):**
- **5-D** membros e beneficiários como **entidades**: membros reais (nome + pubkey FROST) +
  tela Membros; cadastro de beneficiários com pickers; e **aprovação ↔ share que assina** —
  a cerimônia resolve os configs de **quem aprovou** (provado: aprovar como Carol faz a
  `carol.toml` assinar).
- **5-E** as **shares deixam de ficar em texto claro**: configs selados (XChaCha20-Poly1305,
  `konclave seal`) e desselados só para arquivos **efêmeros 0600 em tmpfs** durante a
  assinatura; os textos claros do slice foram removidos (provado por dry-run com só os
  `.sealed`). Custódia da chave: arquivo 0600 (produto usa a keychain do SO).
- **5-F** **criar cofre por DKG pela UI** (`orchestrator/src/dkg.rs`, `POST /api/vault/dkg`,
  tela `Cerimônia`): init → troca de contatos → DKG concorrente (frostd, RedPallas) → grupo
  → `zcash-sign` (endereço Orchard + UFVK) → wallet view-only → **shares seladas** (5-E). A
  chave **nunca é remontada**. Provado ao vivo (CLI e HTTP): cofre 2-de-3 novo com
  endereço/UFVK reais e configs selados.
- **110 testes verdes. Fase 5 (Gate 2) — trilha completa.**

**Estado real do produto (sem overclaim):** o núcleo roda pela UI para **pagamento e
folha** — propor → validar (contínuo) → aprovar/recusar (quórum real, expiração) → **assinar
(FROST com as shares de quem aprovou, seladas em repouso)** → prestar contas (razão + CSV
itemizado). **Provado na mainnet:** 1 **pagamento único** (txid `43433a10…`). **Provado só
por dry-run (assina, NÃO transmite):** a folha multi-saída e o caminho selado — os
**broadcasts reais da folha/selado ainda não foram feitos**.

**Dívidas honestas EM ABERTO (não prometer o que não entrega, §6.15):**
- **Enviar de um cofre DKG recém-criado** exige apontar a cerimônia para os configs dele
  (o servidor usa uma cerimônia só); a **demo financiada** segue no cofre trusted-dealer do
  slice. A **criação** por DKG (5-F) está completa; o **envio** de um cofre DKG novo é o
  follow-up.
- **Broadcast real** da folha e do caminho selado pendentes; empacotamento **Tauri** é
  roadmap (ADR-0004).
- ✅ **Quitadas:** identidade de membro cosmética (5-D.3), shares em texto claro (5-E), e
  DKG não-ligado-na-UI (5-F cria cofre por DKG de verdade).

**Próximo:** Fase 6 (extras) · Fase 7 (README/vídeo/diagrama/vitrine mock) · follow-ups
(envio de cofre DKG · broadcasts reais).
