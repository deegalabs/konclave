# Redesenho da Folha — visão de sistema contábil

> **Status:** plano aprovado (2026-07-01). O motor da folha já existe e é sólido
> (validação linha-a-linha + agregada, envelope único, quórum). O que falta é dar à
> **experiência de trâmite** a cara de um **documento contábil com ciclo de vida**, não a
> de um formulário de importação. Aplicar **aos poucos**, página a página.

## Princípio transversal (vale para todas as telas)

**"Cada movimento de dinheiro é um documento contábil, não um formulário."** Toda página
que mexe com valores deve ter:
1. **Entidades, não strings cruas.** Beneficiário/membro é escolhido de um cadastro (nome),
   não um endereço `u1…` colado.
2. **Competência/período e identidade de documento.** "Folha · abril/2026", com número/ref.
3. **Estados explícitos e visíveis** (rascunho → conferida → aguardando → paga → lançada →
   conciliada), reusando a máquina de estados (o estado `Draft` já existe e está ocioso).
4. **Validação contínua**, não um botão "conferir" à parte.
5. **Totais sempre visíveis** (nº, total, taxa, saldo após).
6. **Razão itemizado**: uma folha de N pessoas vira **N lançamentos**, não 1 linha agregada.

## Ciclo de vida da folha (o alvo)

```
0. CADASTRO        beneficiários existem (nome, endereço, memo padrão)   [depende de 5-D]
        ↓
1. PREPARAR        abrir folha de uma COMPETÊNCIA → tabela EDITÁVEL (importar/escolher/manual)
   (rascunho)      validação contínua por linha; totais ao vivo; SALVAR rascunho (estado Draft)
        ↓
2. CONFERIR        revisão do documento: total, avisos (público, saldo, DUPLICADOS)
        ↓
3. SUBMETER        vira UM documento → "aguardando aprovação" (segregação preparador≠aprovador)
        ↓
4. PAGAR           quórum → assinar (FROST) + transmitir → "paga" (txid)          [5-B.2]
        ↓
5. LANÇAR+CONCILIAR  N lançamentos no razão (data, beneficiário, valor, memo, competência,
                     txid) → on-chain confirma → "conciliada" → export detalhado
```

## Redesenho da tela `Nova Folha` (target)

Substituir o **textarea de CSV + botão "Ler/conferir"** por um **documento editável**:

- **Cabeçalho do documento:** competência (mês/ano), data, descrição; nº de documento gerado.
- **Tabela editável** (uma linha por beneficiário):
  - colunas: beneficiário (do cadastro quando houver; texto+endereço enquanto não houver),
    valor, memo/holerite, avisos inline (endereço público, memo em transparente, valor zero).
  - ações: **+ adicionar linha**, remover linha, **importar planilha** (CSV) que *popula a
    tabela* (o CSV vira um atalho de entrada, não a interface).
  - **validação contínua** por célula; linha inválida fica marcada, não some.
- **Rodapé sempre visível:** nº pagamentos · total · taxa estimada · **saldo após**.
- **Rascunho:** "Salvar rascunho" (persiste como `Draft`); dá pra sair e voltar.
- **Submeter:** "Enviar para aprovação" (um passo claro, separado de conferir) → `Awaiting`.

## Export itemizado (trilha contábil)

`GET /api/ledger.csv` deve emitir **um lançamento por pagamento**:
- pagamento único → 1 linha;
- folha de N → **N linhas** (uma por beneficiário), compartilhando documento/estado/txid.
- colunas propostas: `documento,tipo,estado,proposto_por,aprovadores,beneficiario,valor_zec,
  memo,destino,txid` (competência/data entram quando o cabeçalho de documento existir).

## Encaixe no roadmap

| Item | Onde |
|---|---|
| Export itemizado (N lançamentos) | **trilha contábil** — fatia imediata, independente do 5-D |
| Tabela editável + competência + rascunho (`Draft`) | **5-B.3** (redesenho da UI da folha) |
| Beneficiário como entidade (cadastro de membros) | **5-D** (identidade real de membro) |
| Envio real N-saídas | **5-B.2** (motor multi-saída, `zcash_client_backend`) |
| Conciliação on-chain (sent→confirmed) | **trilha contábil** / 5-C (sync + estados) |

## Fora de escopo agora (incremental, honesto)

Categorias contábeis/plano de contas, recibos/holerite PDF por beneficiário, e
importação de planilhas ricas (xlsx) ficam para depois. A cara contábil entra **página a
página**, não de uma vez.
