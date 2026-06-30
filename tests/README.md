# tests/ — Suíte de testes destrutivos

TDD com **testes que expõem falhas** (CONCEITO §14.9). O código nasce para passar nestes
cenários. Suíte criada na **Fase 3** e mantida até a entrega.

## Cenários obrigatórios
- Quórum insuficiente.
- Share corrompida / ausente.
- `frostd` offline.
- Transação malformada.
- **Endereço Sapling em vez de Orchard** (risco de fundos travados).
- Saldo insuficiente.
- Proposta expirada.
- Reconciliação multi-dispositivo (cache local diverge → on-chain vence).

## Estratégia multi-membro (solo)
Simular N participantes = rodar N identidades `frost-client` contra um `frostd` local.

## Princípio
Falhas **explícitas, nunca silenciosas**. Validação em toda fronteira: entrada de usuário,
saída de binário, dado de rede.
