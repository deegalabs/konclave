// Portuguese (pt-BR) locale. Keys are English; values are the user-facing copy.
// Seeded with the shared proposal state/kind labels; screen copy is migrated incrementally.

export const ptBR: Record<string, string> = {
  // proposal state — lowercase (ledger, payroll status)
  'state.awaiting': 'aguardando',
  'state.ready': 'pronta',
  'state.sent': 'enviada',
  'state.confirmed': 'confirmada',
  'state.rejected': 'recusada',
  'state.expired': 'expirada',
  'state.cancelled': 'cancelada',

  // proposal state — capitalized stamp (proposal detail badge)
  'stamp.awaiting': 'Pendente',
  'stamp.ready': 'Pronta',
  'stamp.sent': 'Enviada',
  'stamp.confirmed': 'Confirmada',
  'stamp.rejected': 'Recusada',
  'stamp.expired': 'Expirada',
  'stamp.cancelled': 'Cancelada',

  // proposal kind
  'kind.payment': 'Pagamento',
  'kind.payroll': 'Folha de pagamento',
  'kindShort.payment': 'pagamento',
  'kindShort.payroll': 'folha',

  // language toggle
  'lang.label': 'Idioma',
  'lang.en': 'EN',
  'lang.pt': 'PT',
}
