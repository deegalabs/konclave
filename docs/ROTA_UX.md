# Konclave — Rota de UX (antes do modelo fiel)

> Plano da Fase 4 (Rosto). O caminho que leva das ideias a telas de alta fidelidade
> **usáveis por um dono de negócio não-técnico**, não por um dev. Companion de
> [ui/design/DESIGN.md](../ui/design/DESIGN.md) e [ROADMAP.md](ROADMAP.md).

## Princípio-âncora

> **Toda a criptografia embaixo do tapete; em cima, um instrumento financeiro que um
> dono de coletivo usa sozinho e entrega pro contador dele.** Segurança e privacidade
> viram *conforto*, não *fricção*.

O usuário nunca vê FROST/DKG/PCZT/sighash. Vê **cofre, membros, aprovar, pagar, fechar
as contas, exportar**.

## Contexto do produto (o que ficou claro)

Uma **DAO/coletivo que cuida de dinheiro comum** e **paga suas pessoas conforme
contribuição**. Operado por um **tesoureiro não-técnico**, que precisa **prestar contas
ao grupo e ao contador** — sem vazar nada on-chain. O track de **Accounting tem peso
igual** ao FROST: prestação de contas e export são cidadãos de primeira classe.

## As 7 etapas

| # | Etapa | Saída |
|---|---|---|
| 1 | **Persona + tarefas (JTBD)** | 1 página de persona + tarefas priorizadas |
| 2 | **Arquitetura de informação** | Mapa de IA + o que cada tela responde |
| 3 | **Os 4 fluxos que importam** | Jornadas passo-a-passo (estados/erros) |
| 4 | **Wireframes de baixa fidelidade** | Esquemas estruturais das telas núcleo |
| 5 | **Copy / conteúdo** | Guia de voz + strings das telas núcleo |
| 6 | **Modelo fiel (hi-fi) no "Lacre"** | Telas núcleo em alta fidelidade |
| 7 | **Frontend real (Next.js) + integração** | Rosto ligado ao Orquestrador (Fase 5) |

Etapas 1–3 estão em [UX_FUNDACAO.md](UX_FUNDACAO.md).

## Calibragem do "Lacre" (decisão desta rota)

Mantém-se o **Lacre** (documento/livro-razão combina com contabilidade), porém
**calibrado para ferramenta usável**, não peça cerimonial: densidade e clareza onde
conta (o **Razão/Prestação de contas**), guiado e caloroso na copy, sempre sob o modelo
da **tarja** (transparência interna, opacidade externa).

⚠️ **Risco vigiado:** o Lacre é sério/austero — bom pra dinheiro, mas **não pode
intimidar** o dono não-técnico. Cura = **guia + linguagem simples + preview em tudo**,
não trocar a estética.

## A tensão que é o diferencial

App de contabilidade **mostra número em tudo**; o Konclave **esconde** (shielded). Não é
conflito — é o posicionamento único: *"contabilidade que o grupo confia por dentro,
invisível por fora"*. Pega-se do mundo bookkeeping a **clareza, o razão e o export**;
**não** o "expor tudo" nem o escopo de suíte financeira (sem faturas/contas a pagar —
somos **tesouraria blindada com prestação de contas**).

## Ordem de execução

Etapas **1–3 juntas** (alicerce barato) → **4 (wireframes)** para validar facilidade →
**6 (hi-fi)** só então. Etapa 5 (copy) permeia 4 e 6.
