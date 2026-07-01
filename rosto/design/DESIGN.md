# Konclave — Design System ("Lacre")

> Direção visual do Rosto. Fonte de verdade para tokens, tipografia e o
> elemento-assinatura. Deriva do brief de UX ([UX_E_FLUXOS](../../docs/UX_E_FLUXOS.md) §10):
> *esconder a criptografia, expor a confiança* · *cofre sólido + discrição* · anti-default.

## Conceito

Um **instrumento financeiro / dossiê selado** — papel institucional, plano e rigoroso,
como uma cédula, um passaporte ou um livro-razão. Confiança pela **estrutura e
precisão**; sigilo pela **redação (tarja de censura)**. Amarra com o nome: *Konclave* =
conclave, sala lacrada → **cera de lacre (oxblood)**.

Escolha deliberada de **fugir dos clichês** — inclusive os que o brief já bania
(cream+serifa+terracota; preto+verde-ácido; jornalão com fios) **e** o clichê atual de
"site feito por IA" (dark-SaaS + serifa display + dourado + cards flutuantes).

## Elemento-assinatura — a TARJA (redação)

A privacidade é um **gesto físico e temático**. Todo valor sensível nasce **censurado
por uma tarja sólida** ("SIGILOSO"), como um documento sigiloso. "Revelar" **retira a
tarja** (colapsa da esquerda). É a interação memorável e o tratamento próprio do estado
shielded que o brief exige — no lugar de um borrão genérico.

Complemento: o **selo de lacre** — um emblema circular com **guilhochê** (fino-traçado
de cédula) e o quórum ("2/3"), lido como um lacre oficial.

## Paleta (papel + tinta + lacre)

| Token | Hex | Uso |
|---|---|---|
| `--paper` | `#E6E3DB` | Fundo — papel arquivístico frio (não "cream") |
| `--paper-2` | `#EEEBE3` | Campos/insets |
| `--ink` | `#1A1813` | Tinta — texto, tarjas, fios estruturais |
| `--muted` | `#6C685C` | Texto secundário |
| `--line` | `#C7C2B4` | Fios finos |
| `--seal` | `#7E2A24` | **Oxblood** — selo, carimbos, ações, links (cera de lacre) |
| `--pine` | `#37493C` | Entradas/recebido (verde arquivístico abafado — laço com Orchard) |

Um acento (oxblood), usado com parcimônia. Contraste AA sobre papel. Sem gradiente,
sem brilho, sem dourado, sem verde-ácido.

## Tipografia

- **`Archivo`** (grotesca institucional): títulos em **caixa-alta pesada e travada**
  (feito um carimbo), rótulos e UI. Sólida, séria, humana — não serifa "de IA".
- **`Spline Sans Mono`**: cifras, endereços, txids, metadados. Precisão de livro-razão;
  dinheiro sempre em mono, inequívoco.

## Layout & estrutura

Documento: plano, **cantos retos**, **fios** dividindo seções (com parcimônia — não
jornalão), grid rigoroso, margens de folha. Letterhead no topo. Rótulos em mono
caixa-alta travada. Sem sombra, sem card flutuante.

## Movimento

Contido. A **tarja colapsa** ao revelar (~280ms). Nada de brilho ou parallax.
`prefers-reduced-motion` respeitado.

## Princípios de interação (do brief)

Esconder cripto, expor confiança · preview + confirmação em toda ação que move fundos ·
copy honesta e ativa ("Propor" → "Aprovar" → "Enviado") · erros dirigem, não se
desculpam · privacidade como gesto (a tarja) · estados sempre visíveis.

## Acessibilidade (piso)

Foco visível (anel `--seal`), contraste AA, `prefers-reduced-motion`, alvo ≥ 44px, a
tarja tem rótulo ARIA e ação por teclado.

## Fontes (Google Fonts)

`Archivo` (400–800) · `Spline Sans Mono` (400/500/600).

## Referência

Protótipo interativo: [prototype.html](prototype.html) — o Painel (tela interna, vista
**depois** de entrar num cofre; a Abertura/cerimônia vêm antes).
