# Konclave

> **O cofre que decide em conjunto.** Nenhum pagamento sai sem o quórum.
> Privado por fora, transparente por dentro.

Konclave é um app **desktop local-first** que torna usável, para pessoas comuns, criar e
operar um **cofre de fundos coletivo e privado** sobre a rede **Zcash**, usando
assinaturas de limiar (**FROST**). Pague por quórum ou rode uma **folha de pagamento
privada** inteira num único envelope aprovado coletivamente — sem tocar em linha de
comando, e sem vazar nada na blockchain pública.

A criptografia já existe e é das ferramentas oficiais da **Zcash Foundation**. O que
faltava era a **camada humana** — é isso que o Konclave entrega.

> ⚠️ **Status:** em construção (ZecHub Hackathon 3.0, 2026). Este README é provisório;
> a vitrine completa, com demo na mainnet e link de transação real, vem na entrega final.

## Documentação

- [CLAUDE.md](CLAUDE.md) — memória e contexto do projeto.
- [docs/CONCEITO_INICIAL.md](docs/CONCEITO_INICIAL.md) — o quê e o porquê.
- [docs/UX_E_FLUXOS.md](docs/UX_E_FLUXOS.md) — jornadas e telas.
- [docs/LOGICA_E_REGRAS.md](docs/LOGICA_E_REGRAS.md) — estados e regras.
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md) — as três camadas.
- [docs/ROADMAP.md](docs/ROADMAP.md) — plano de construção.

## Como funciona (em uma frase)

A chave do cofre é dividida entre os membros; **nenhum pedaço sozinho move fundos** e a
chave inteira **nunca é remontada**. As aprovações produzem uma assinatura única que, de
fora, parece uma transação normal de uma pessoa só. A sua parte da chave **nunca sai do
seu dispositivo**.

## Crédito

Construído sobre as ferramentas da **Zcash Foundation**: `frostd`, `frost-client`
([frost-tools](https://github.com/ZcashFoundation/frost-tools)), o Zcash Signer e
[zcash-devtool](https://github.com/zcash/zcash-devtool). O Konclave não reimplementa
criptografia — agrega a camada de usabilidade por cima.

## Licença

Dual **Apache-2.0** / **MIT**, à escolha do usuário (espelha o ecossistema Rust/Zcash).
Ver [LICENSE-APACHE](LICENSE-APACHE) e [LICENSE-MIT](LICENSE-MIT).
