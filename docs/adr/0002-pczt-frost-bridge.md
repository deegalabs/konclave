# ADR-0002 — The PCZT/FROST integration gap and the konclave-signer bridge

- **Status:** aceito
- **Data:** 2026-07-01
- **Contexto:** Fase 1 (vertical slice). Ao executar o fluxo real de gasto Orchard
  com FROST na mainnet, descobrimos que as ferramentas oficiais **não interoperam**
  hoje neste passo.

## Descoberta

O [CONCEITO_INICIAL.md](../CONCEITO_INICIAL.md) §6 assumia que "o fluxo completo
FROST → transação Zcash já existe e funciona hoje". Isso é verdade **apenas para a
combinação exata do tutorial Ywallet** (Ywallet + `zcash-sign`, co-mantidos). Ao
usar uma carteira **headless** (`zcash-devtool`, escolha coerente com o produto
local-first), surge um vão de integração:

- **`zcash-sign`** (frost-tools): injeta assinatura FROST, mas lê apenas PCZT no
  stack antigo (`pczt 0.5` / `orchard 0.11-fork`, feature `unstable-frost`); o
  caminho Ywallet está desativado (`#[cfg(false)]`). Contra o PCZT do devtool,
  `into_effects()` falha ("Not enough information to build the transaction's effects").
- **`zcash-devtool`** (zcash): cria/prova/transmite PCZT no stack novo
  (`pczt 0.7` / `orchard 0.14`), mas `pczt update-with-signature` retorna
  `"TODO: Maybe support this"` para o pool **Orchard** (só transparente implementado).

Ou seja: um cria a transação mas não injeta assinatura Orchard; o outro injeta mas
não lê o PCZT novo. Nenhum binário oficial fecha o ciclo sozinho.

## Decisão

Construir **`konclave-signer`** — uma ponte mínima que:
1. lê o PCZT provado do `zcash-devtool`, computa o `sighash` (v5) e extrai o
   `randomizer` (alpha) de cada gasto real (dummies filtrados);
2. após a cerimônia FROST, injeta a assinatura redpallas via
   `orchard::pczt::Action::apply_signature`, que **valida** a assinatura contra a
   chave randomizada `rk` antes de aplicar.

Fixada nas **mesmas versões do `zcash-devtool`** (`orchard 0.14` com
`unstable-frost`, `pczt 0.7`, librustzcash `rev 08334ebe`) para que o formato de
fio do PCZT case byte a byte. Descoberta habilitadora: **o `orchard 0.14` mainline
já traz os ganchos de FROST** (`unstable-frost`, `apply_signature`, acesso a
`alpha`) — o fork antigo foi upstreamado.

## Consequências

- É **cola, não criptografia**: só chamadas às bibliotecas oficiais; a matemática
  FROST permanece no `frost-core`. Não viola "Caminho 1 / não reimplementar cripto".
- Não é desvio de escopo: é o **núcleo do Orquestrador** (Camada 2, sempre código
  nosso), construído mais cedo. Será dobrado em `src-tauri/` na Fase 3.
- **Correção de honestidade** ao CONCEITO §6: o "já funciona hoje" vale só para a
  combinação Ywallet+zcash-sign; com carteira headless, é preciso fixar um conjunto
  compatível **ou** ser dono da ponte. O `motor/versions.lock` fixa o conjunto.
- Comunicação FROST na demo: `frostd` exige HTTPS; para teste local geramos uma CA
  local + cert-folha para `127.0.0.1` na loja do sistema (reqwest usa
  `rustls-tls-native-roots`). Participantes confirmam com `y` (prompt interativo).

## Prova

Primeira transação FROST do Konclave na mainnet:
`f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360` (bloco 3.396.616).
Fluxo completo em [VERTICAL_SLICE.md](../VERTICAL_SLICE.md).
