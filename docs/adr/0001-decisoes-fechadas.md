# ADR-0001 — Decisões fechadas de arquitetura

- **Status:** aceito
- **Data:** 2026-06-30
- **Contexto:** Konclave (ZecHub Hackathon 3.0). Decisões consolidadas do
  [CONCEITO_INICIAL.md §13](../CONCEITO_INICIAL.md) e da conversa de logística inicial.

## Decisão

### Produto (fonte: CONCEITO §13)
1. **Nome:** Konclave.
2. **Plataforma:** desktop local-first via Tauri (shell Rust + Next.js/React).
3. **Integração com o motor:** Caminho 1 (invocar binários CLI oficiais) com rigor de
   Caminho 2 (saída estruturada, validação em toda fronteira, TDD destrutivo).
4. **Custódia:** key share nunca sai do dispositivo (keychain do SO); entre membros
   trafega só material público.
5. **Coordenação:** `frostd` oficial (servidor cego) + fallback QR/copy-paste (stretch).
6. **Geração de chave do produto:** DKG real (trusted-dealer só como andaime do slice).
7. **Rede:** mainnet, ZEC real, valor mínimo; receber só em Orchard.
8. **Privacidade:** shielded-first; sem telemetria; segredos nunca em log/disco/URL.
9. **Escopo:** núcleo + 3 extras promovidos; stretch e roadmap separados.
10. **Licença:** dual Apache-2.0 / MIT.

### Técnicas (fonte: logística)
11. **Equipe:** solo → escopo travado no núcleo; extras só se sobrar fôlego.
12. **SO de dev:** Windows nativo primeiro; WSL2 só se o tooling quebrar.
13. **Origem dos binários:** compilar da fonte, pinados por SHA, vendorizados como
    submódulos, com checksum em `motor/versions.lock`. Pin ancorado no commit do tutorial
    oficial FROST+Zcash (caminho conhecido-bom), garantindo coerência de versões de
    `frost-core`/`reddsa` entre as ferramentas.
14. **Camada carteira:** linkar `zcash_client_backend` no Rust para sync/saldo/plano
    (dado estruturado nativo); shellar apenas os binários FROST/sign.
15. **Frontend:** Next.js em static export.

## Consequências
- Os binários **devem** ser mutuamente compatíveis no SHA pinado (mesma versão de
  `frost-core`/`reddsa`), sob risco de a assinatura não verificar.
- A promessa "share nunca sai do dispositivo" exige reconciliar onde o `frost-client`
  guarda a share (storage próprio) com o keychain — decidir na Fase 1/3.
- Buildar contra **NU6.2** (hard-fork de 03/jun/2026 que reabilitou o Orchard).

## Decisões adiadas (logística)
Prazo de expiração de proposta (placeholder 72h), limite de linhas por folha, colunas do
CSV, fonte de tempo confiável para expiração, hospedagem do `frostd` na demo.
