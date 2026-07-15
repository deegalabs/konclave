# ui/: Camada 3 (interface)

A experiência humana. **Next.js/React** em static export, servido pelo Tauri. Princípio
mestre: **esconder a criptografia, expor a confiança**. O usuário vê cofre, membros,
aprovação, pagamento; nunca "FROST", "DKG", "SIGHASH".

## Telas (a partir da Fase 4)
Abertura · Criar/Entrar cofre (cerimônia) · Painel (saldo/pendências/histórico) ·
Novo pagamento · Nova folha · Proposta (aprovar/recusar) · Enviado (link explorador) ·
Saldo/Histórico · Membros · Propostas pendentes.

## Regras de interação
- Toda ação que move fundos: **preview + confirmação explícita**. Nunca clique único.
- Copy honesta e ativa ("Propor pagamento" → "Aprovar" → "Enviado").
- Erros dirigem, não se desculpam. Estados sempre visíveis.
- Privacidade como gesto: ocultar/mostrar saldo nativo.
- Acessibilidade de piso: foco de teclado, contraste, motion reduzido.

## Design
Token system (paleta, tipografia, elemento-assinatura) derivado do mundo Zcash/Orchard,
definido na **Fase 4A** com a skill `frontend-design`, validado antes de virar tela.
Desenvolve contra **mock** do Orquestrador (`ui/mocks/`) até a integração (Fase 5).
