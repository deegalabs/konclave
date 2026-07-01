# Konclave — Design System ("O Cofre Selado")

> Direção visual do Rosto. Fonte de verdade para tokens, tipografia e o
> elemento-assinatura. Deriva do brief de UX ([docs/UX_E_FLUXOS.md](../../docs/UX_E_FLUXOS.md) §10):
> *esconder a criptografia, expor a confiança* · *cofre sólido + discrição* · anti-default.

## Conceito

Um **cofre coletivo à meia-luz**: escuro, arquitetônico, discreto. Sério sobre dinheiro
e sigilo — não fintech alegre, não terminal hacker. Deriva do mundo **Orchard/shielded**
(profundidade, jardim murado, véu) sem literalidade floral.

## Elemento-assinatura — o VÉU

A privacidade é um **gesto físico**. Todo valor sensível (saldo, montantes) nasce
**coberto por um véu fosco** (vidro fosco + grão + glifo de escudo). "Revelar" **ergue o
véu** com uma animação de desfoque→nitidez. É a interação memorável da interface e o
tratamento próprio do estado shielded que o brief exige.

Complemento: o **selo de quórum** — um anel de pontos (ex.: 2 de 3 preenchidos), lido
como um lacre.

## Paleta (6 tokens nomeados + estados)

| Token | Hex | Uso |
|---|---|---|
| `--vault` | `#0E1311` | Fundo — o interior do cofre (quase-preto, subtom verde/Orchard) |
| `--panel` | `#161D1A` | Superfícies elevadas (cards) |
| `--line` | `#26302B` | Fios/bordas (1px) |
| `--text` | `#EAEFEA` | Texto principal (off-white quente) |
| `--muted` | `#8A968F` | Texto secundário |
| `--brass` | `#C79A4E` | **Acento precioso** — quórum, aprovação, CTA (latão de cofre, não ouro fintech) |
| `--shield` | `#77A08B` | Sinal de privacidade/shielded (sálvia-teal, laço com Orchard) |
| `--brick` | `#BC5D50` | Recusa/erro (tijolo abafado — "erros dirigem, não alarmam") |

Regras: fundo dominante escuro, **um** acento (brass) usado com parcimônia. Contraste
mínimo AA sobre `--vault`. Sem gradientes roxos, sem verde-ácido, sem cream+serif.

## Tipografia (par display + texto + mono)

- **Display — `Instrument Serif`**: títulos, nome do cofre. Serifa de alto contraste,
  editorial e discreta — dá gravidade sem virar "luxo de igreja".
- **Texto/UI — `Hanken Grotesk`**: corpo, rótulos, botões. Limpa, quente, legível.
- **Mono — `IBM Plex Mono`**: montantes, endereços, txids. Legibilidade financeira e
  "confiança técnica". Dinheiro sempre em mono, nunca ambíguo.

## Layout & espaço

Calmo, arquitetônico, com **espinha vertical** e respiro generoso. Densidade controlada.
Cantos suaves (raio 14–18px nos cards). Sombra profunda e difusa (não "material").

## Movimento

Contido e refinado. Carga da página: **revelação escalonada** (staggered). O **erguer do
véu**: `blur→0` + leve translate + fade, ~450ms ease. Aprovação: o anel de latão
**preenche**. `prefers-reduced-motion` respeitado (sem exceção).

## Princípios de interação (do brief)

1. Esconder cripto, expor confiança.
2. Toda ação que move fundos: **preview + confirmação explícita**.
3. Copy honesta e ativa ("Propor" → "Aprovar" → "Enviado").
4. Erros dirigem, não se desculpam.
5. Privacidade como gesto (o véu).
6. Estados sempre visíveis (a máquina de estados reflete na UI).

## Acessibilidade (piso, não enfeite)

Foco de teclado visível (anel `--brass`), contraste AA, `prefers-reduced-motion`,
área de toque ≥ 44px, o véu tem alternativa por teclado e rótulo ARIA.

## Fontes (Google Fonts)

`Instrument Serif` · `Hanken Grotesk` (400/500/600/700) · `IBM Plex Mono` (400/500).
