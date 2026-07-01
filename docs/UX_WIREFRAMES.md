# Konclave — Wireframes de baixa fidelidade (Etapa 4)

> Estrutura e hierarquia, **sem cor/tipo** — o objetivo é validar a **facilidade** para
> a Marina (não-técnica) antes do modelo fiel. Legenda: **▸** ação primária · **⚑**
> preview+confirmação · **⚠** erro/estado · **🔒** valor sob a tarja · *(itálico)* = roda
> escondido. Segue [UX_FUNDACAO.md](UX_FUNDACAO.md).

---

## 1. Abertura (sem cofre ainda)

```
┌──────────────────────────────────────────────────────────┐
│  ◧ KONCLAVE                                                │
│                                                            │
│      O cofre que decide em conjunto.                       │  tese em 1 linha
│      Privado por fora, transparente por dentro.            │
│                                                            │
│   ┌───────────────────────┐   ┌───────────────────────┐   │
│   │  ▸ CRIAR COFRE         │   │    ENTRAR NUM COFRE    │   │
│   │    começar um grupo    │   │    tenho um convite    │   │
│   └───────────────────────┘   └───────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```
Só dois caminhos. Zero jargão. Nada de "wallet/seed/chave".

---

## 2. Cerimônia — Criar cofre  (stepper de 4 passos)

```
 [●───○───○───○]  1. Definir   2. Convidar   3. Criar   4. Endereço
```

**Passo 1 — Definir**
```
┌───────────────────────────────────────────────┐
│  Nome do cofre   [ Tesouraria da comunidade  ] │
│                                                │
│  Quantas pessoas precisam aprovar cada         │  regra em linguagem
│  pagamento?                                    │  humana (não "threshold")
│      [ 2 ] de [ 3 ]  membros   ◁ seletor       │
│  ↳ "Ninguém sozinho controla o dinheiro."      │  microcopy da consequência
│                                    [ ▸ Avançar ]│
└───────────────────────────────────────────────┘
```

**Passo 2 — Convidar**
```
┌───────────────────────────────────────────────┐
│  Envie este convite para cada pessoa:          │
│   [ konclave://convite/9f2… ]  [copiar] [QR]   │
│                                                │
│  Membros            Aguardando 2 de 3 entrarem │
│   ✓ Você (dona)                                │
│   ✓ Bruno           entrou                     │
│   ⋯ Carla           aguardando…                │
│                                    [ ▸ Avançar ]│  (habilita quando todos entram)
└───────────────────────────────────────────────┘
```

**Passo 3 — Criar (a cerimônia)**
```
┌───────────────────────────────────────────────┐
│  ⚠ Todos precisam estar no app agora.          │  aviso ANTES de iniciar
│                                                │
│         [ ▸ Criar cofre agora ]                │
│  ───────────────────────────────              │
│  Gerando as chaves do cofre…  (acontece 1 vez) │  progresso, linguagem neutra
│  ↳ "Sua parte da chave fica só neste aparelho. │  (roda o DKG via frostd;
│     Ela nunca sai daqui."                      │   share cifrada localmente)
└───────────────────────────────────────────────┘
  ⚠ Membro caiu → "A criação parou porque [nome] saiu. Recomece quando todos
     estiverem prontos."   ⚠ frostd fora → oferecer QR/copy-paste.
```

**Passo 4 — Endereço pronto**
```
┌───────────────────────────────────────────────┐
│  ✓ Seu cofre está pronto.                      │
│  Endereço para receber ZEC:                    │
│   [ u1vjgx…d406dr ]  [copiar]  [QR]            │
│  ⚠ Receba apenas em endereço Orchard.          │  guardrail (fundos travados)
│                              [ ▸ Ir ao painel ]│
└───────────────────────────────────────────────┘
```

---

## 3. Novo pagamento

```
┌───────────────────────────────────────────────┐
│  ← Painel            Novo pagamento            │
│                                                │
│  Para   [ endereço Zcash…                    ] │  ✓ válido? ✓ shielded?
│         ⚠ "Este destino é público" (se transp.)│
│  Valor  [ 0.5 ] ZEC        disponível: 🔒 2.41 │  ≤ disponível (saldo−reserva−taxa)
│  Memo   [ ref maio                    ] 6/512  │  só shielded · contador
│         (recibo/holerite — só o destinatário lê)│
│  ─────────────────────────────────────────    │
│  Taxa estimada  0.0001 ZEC   ·  Saldo após 🔒  │  ZIP 317, sem surpresa
│                                                │
│  ⚑ Preview: "Você vai PROPOR 0,5 ZEC → zs1…    │  confirmação explícita
│     Precisa de 2 aprovações (incluindo a sua)."│
│                          [ ▸ Propor pagamento ]│  (não "enviar" — copy honesta)
└───────────────────────────────────────────────┘
```
*(monta plano → PCZT → extrai o que assinar; a proponente já conta como 1ª aprovação.)*

---

## 4. Nova folha  (o segundo rosto — N destinos)

```
┌──────────────────────────────────────────────────────────┐
│  ← Painel      Nova folha        [ ⭱ Importar CSV ]        │
│                                                            │
│  #  Rótulo     Endereço          Valor      Memo/holerite  │
│  1  Ana        u1ana…           [0.5 ]     [abril      ]   │
│  2  Bruno      u1bruno…         [0.25]     [abril      ]   │
│  3  Carla      t1carla…  ⚠pub   [0.30]     [—          ]   │  linha inválida sinalizada
│  [ + adicionar linha ]  [ duplicar ]                       │
│  ──────────────────────────────────────────────────────  │
│  RODAPÉ VIVO:  8 pagamentos · total 🔒 · taxa est. 🔒 ·    │  cresce c/ nº destinos
│                saldo após 🔒                               │
│                                                            │
│  ⚑ "Folha de maio — 8 pagamentos. Precisa de 2 aprovações."│
│                                    [ ▸ Propor folha ]      │  (bloqueado se linha inválida)
└──────────────────────────────────────────────────────────┘
```

**Estado — relatório de import CSV**
```
┌───────────────────────────────────────────────┐
│  Importado: 7 linhas aceitas · 1 com erro      │
│   ⚠ linha 4: valor inválido ("oops")           │  motivo + nº da linha
│   [ Ignorar a linha 4 e continuar ]  [ Revisar ]│  import parcial permitido
└───────────────────────────────────────────────┘
```
*(vira UMA transação com N saídas → UMA aprovação cobre tudo.)*

---

## 5. Proposta (detalhe) — aprovar / acompanhar

```
┌───────────────────────────────────────────────┐
│  ← Propostas          PENDENTE                 │
│  0.5000 ZEC → zs1q9f…7ka2                       │  (valor sob 🔒 até revelar)
│  memo "adiantamento maio"                      │
│  Proposto por Bruno                            │
│  Progresso  [██──]  1 de 2  · quem já aprovou: Bruno │
│  Expira em 71h                                 │
│                                                │
│  ↳ "Ao aprovar, você autoriza este pagamento   │  microcopy de responsabilidade
│     com a sua parte da chave."                 │
│        [ ▸ Aprovar ]     [ Recusar ]           │
│                                                │
│  (se sou o proponente: vejo "aguardando os     │  visão muda por papel (§6.7)
│   outros" + [ Cancelar ])                      │
└───────────────────────────────────────────────┘
  Estados: Aguardando · Pronta/enviando · Recusada · Expirada · Enviada
  → ao bater 2 de 2, vai à mainnet automaticamente. (cerimônia FROST via frostd)
```

---

## 6. Enviado (confirmação)

```
┌───────────────────────────────────────────────┐
│              ✓ Pagamento enviado               │
│         0.5000 ZEC → zs1q9f…7ka2                │
│                                                │
│   [ ▸ Ver no explorador ↗ ]  (prova on-chain)  │  verificabilidade
│   [ Voltar ao painel ]                         │
│                                                │
│  O memo/holerite fica acessível só ao          │
│  destinatário.                                 │
└───────────────────────────────────────────────┘
```

---

## 7. Razão / Prestação de contas  (o pedido do contador)

```
┌──────────────────────────────────────────────────────────┐
│  ← Painel     Razão / Prestação de contas   [ ⭳ Exportar ]│  CSV/PDF, local
│                                                            │
│  Filtros: [ mês ▾ ] [ membro ▾ ] [ tipo ▾ ]   [ 🔒 ocultar]│  período/membro/tipo
│  ─────────────────────────────────────────────────────── │
│  DATA    DESCRIÇÃO              QUEM               VALOR   │  cabeçalho de razão
│  28/04   Folha de abril (8)     prop. Ana          −🔒     │
│                                 aprov. Ana, Bruno   ↗      │  quem propôs/aprovou
│  22/04   Doação recebida        —                  +🔒     │
│  15/04   Pgto infraestrutura    prop. Bruno         −🔒    │
│                                 aprov. Bruno, Carla  ↗     │
│  ─────────────────────────────────────────────────────── │
│  Saldo do período: 🔒     (tudo sob a tarja; revelar é gesto)│
│                                                            │
│  ↳ "Transparência interna. A blockchain pública nada      │
│     revela." — entregue este export ao seu contador.      │
└──────────────────────────────────────────────────────────┘
```
*(read-only via UFVK — mostra sem poder gastar; export gerado localmente.)*

---

## O que estes wireframes provam (checklist de usabilidade)
- [x] Cada tela tem **uma** ação primária óbvia (▸).
- [x] **Preview + confirmação** em tudo que move fundos (⚑) — nunca 1 clique dispara ZEC.
- [x] **Zero jargão cripto** visível; a segurança aparece como microcopy de confiança.
- [x] O **Razão + Export** dá conta do "entregar ao contador" (track Accounting).
- [x] Erros **dirigem** (⚠): dizem o que houve e o que fazer.
- [x] A **tarja (🔒)** protege valores por padrão em toda superfície.
- [x] A **folha** aceita planilha (CSV) — o mundo real do tesoureiro.
