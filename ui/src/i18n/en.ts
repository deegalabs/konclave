// English (en) locale. Keys are English; values are the user-facing copy.
// Seeded with the shared proposal state/kind labels; screen copy is migrated incrementally.

export const en: Record<string, string> = {
  // proposal state — lowercase (ledger, payroll status)
  'state.awaiting': 'awaiting',
  'state.ready': 'ready',
  'state.sent': 'sent',
  'state.confirmed': 'confirmed',
  'state.rejected': 'rejected',
  'state.expired': 'expired',
  'state.cancelled': 'cancelled',

  // proposal state — capitalized stamp (proposal detail badge)
  'stamp.awaiting': 'Pending',
  'stamp.ready': 'Ready',
  'stamp.sent': 'Sent',
  'stamp.confirmed': 'Confirmed',
  'stamp.rejected': 'Rejected',
  'stamp.expired': 'Expired',
  'stamp.cancelled': 'Cancelled',

  // proposal kind
  'kind.payment': 'Payment',
  'kind.payroll': 'Payroll',
  'kindShort.payment': 'payment',
  'kindShort.payroll': 'payroll',

  // language toggle
  'lang.label': 'Language',
  'lang.en': 'EN',
  'lang.pt': 'PT',
}
