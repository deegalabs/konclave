// Single source for proposal state/kind labels, so screens don't each redefine (and drift
// on) the same maps. Currently PT-BR; when the UI is internationalized these become the
// values behind the i18n keys — one place to translate.

const STATE_LABEL: Record<string, string> = {
  awaiting: 'aguardando', ready: 'pronta', sent: 'enviada',
  confirmed: 'confirmada', rejected: 'recusada', expired: 'expirada', cancelled: 'cancelada',
}

const STATE_STAMP: Record<string, string> = {
  awaiting: 'Pendente', ready: 'Pronta', sent: 'Enviada',
  confirmed: 'Confirmada', rejected: 'Recusada', expired: 'Expirada', cancelled: 'Cancelada',
}

/** Lowercase state label (ledger, payroll status). Falls back to the raw state. */
export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? state
}

/** Capitalized state stamp (proposal badge; "awaiting" reads as "Pendente"). */
export function stateStamp(state: string): string {
  return STATE_STAMP[state] ?? state
}

/** Human label for a proposal kind. */
export function kindLabel(kind: string): string {
  return kind === 'payroll' ? 'Folha de pagamento' : 'Pagamento'
}

/** Short lowercase kind word ("folha" / "pagamento"). */
export function kindShort(kind: string): string {
  return kind === 'payroll' ? 'folha' : 'pagamento'
}
