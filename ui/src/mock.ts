// Coherent, self-consistent demo dataset for the HOSTED demo (no backend).
//
// On the Vercel demo there is no local bridge, so every `/api/*` read fails and returns null.
// When VITE_DEMO === '1', `api.ts` falls back to this dataset so every screen renders a fully
// populated, believable product instead of empty placeholders. Every field matches the exact
// types in `api.ts`; the numbers are internally consistent (balance ⊇ open spends, ledger ⊇
// open proposals, payroll totals = Σ lines).

import type { Vault, Proposal, Balance, PayrollLine, Beneficiary } from './api'

// Recent, varied timestamps (seconds). `days` ago from now.
const ago = (days: number): number => Math.floor(Date.now() / 1000) - Math.floor(days * 86400)
// A little into the future, for `expiry_unix` on still-open proposals.
const inHours = (h: number): number => Math.floor(Date.now() / 1000) + Math.floor(h * 3600)

const ORCHARD_ADDRESS =
  'u1vjgxlvz4ewnt43rkq6fzexpl639745spx369tc4j9n9l0qnt9rufxdt2pxe3jtku7lqv4gtzfqafxtf7gal5y9gmz84nkza6z5d406dr'

// ---- members ----

const MEMBERS = [
  { name: 'Alice', pubkey: '02a1b3c4d5e6f70819' + '2a3b4c5d6e7f8091a2b3c4d5e6f70819a2b3c4d5e6f7' },
  { name: 'Bob', pubkey: '03b2c4d5e6f7081920' + '3b4c5d6e7f8091a2b3c4d5e6f70819a2b3c4d5e6f708' },
  { name: 'Carol', pubkey: '02c3d5e6f708192031' + '4c5d6e7f8091a2b3c4d5e6f70819a2b3c4d5e6f70819' },
]

export const vault: Vault = {
  id: 'demo',
  name: 'Tesouraria Comum',
  threshold: 2,
  total: 3,
  members: 3,
  member_list: MEMBERS,
  group_pubkey: '0ab93649e62dd68858ed57af1e7f7743cc2a4912110d7fb547d35c8c8494ee34',
  orchard_address: ORCHARD_ADDRESS,
  server_url: 'https://frostd.demo.konclave.app',
  locked: false,
}

export const vaults: Vault[] = [vault]

// ---- balance ----
// total 2.4180 ZEC = 241800000 zat; pending +0.0100 = 1000000 zat; spendable 2.4080 = 240800000 zat.

export const balance: Balance = {
  configured: true,
  chain_tip_height: 3396742,
  total_zat: 241800000,
  total_zec: '2.4180',
  spendable_zat: 240800000,
  spendable_zec: '2.4080',
  pending_zat: 1000000,
  pending_zec: '0.0100',
}

// ---- beneficiaries (address book) ----

export const beneficiaries: Beneficiary[] = [
  {
    id: 'ben-1',
    name: 'Fornecedor Papelaria',
    address:
      'u1qxmz7a5c8v9b0n2m4k6j8h0g2f4d6s8a1q3w5e7r9t1y3u5i7o9p1a3s5d7f9g1h3j5k7l9z1x3c5v7b9n1m3',
    memo: 'material de escritório',
    is_public: false,
  },
  {
    id: 'ben-2',
    name: 'Cooperativa Solidária',
    address:
      'u1coopr8v3n5m7k9j1h3g5f7d9s1a3q5w7e9r1t3y5u7i9o1p3a5s7d9f1g3h5j7k9l1z3x5c7v9b1n3m5k7j9',
    memo: '',
    is_public: true,
  },
  {
    id: 'ben-3',
    name: 'Contadora · Marta',
    address:
      'u1cont4d0r5a6b7c8d9e0f1g2h3i4j5k6l7m8n9o0p1q2r3s4t5u6v7w8x9y0z1a2b3c4d5e6f7g8h9i0j1k2l3',
    memo: 'honorários contábeis',
    is_public: false,
  },
  {
    id: 'ben-4',
    name: 'Bolsa · Pesquisa',
    address:
      'u1bolsa9z8y7x6w5v4u3t2s1r0q9p8o7n6m5l4k3j2i1h0g9f8e7d6c5b4a3z2y1x0w9v8u7t6s5r4q3p2o1n0',
    memo: 'bolsa de pesquisa',
    is_public: true,
  },
]

// ---- proposals ----

// 1) AWAITING payment that "needs you": only Alice has approved (1 of 2).
const propAwaitingPayment: Proposal = {
  id: 'prop-101',
  vault_id: 'demo',
  kind: 'payment',
  state: 'awaiting',
  proposer: 'Alice',
  value_zat: 50000000,
  value_zec: '0.5000',
  memo: 'adiantamento maio',
  to_address: beneficiaries[0]!.address,
  is_public: false,
  expiry_unix: inHours(58),
  created_at: ago(0.6),
  approvals: ['Alice'],
  refusals: [],
  approvals_count: 1,
}

// 2) READY payment: quorum reached (Bob + Carol).
const propReadyPayment: Proposal = {
  id: 'prop-102',
  vault_id: 'demo',
  kind: 'payment',
  state: 'ready',
  proposer: 'Bob',
  value_zat: 12000000,
  value_zec: '0.1200',
  memo: 'reembolso transporte',
  to_address: beneficiaries[1]!.address,
  is_public: true,
  expiry_unix: inHours(41),
  created_at: ago(1.2),
  approvals: ['Bob', 'Carol'],
  refusals: [],
  approvals_count: 2,
}

// 3) AWAITING payroll: proposed by Carol, one approval so far.
const propAwaitingPayroll: Proposal = {
  id: 'prop-103',
  vault_id: 'demo',
  kind: 'payroll',
  state: 'awaiting',
  proposer: 'Carol',
  value_zat: 30000000,
  value_zec: '0.3000',
  memo: 'folha de bolsas · maio',
  is_public: false,
  expiry_unix: inHours(66),
  created_at: ago(0.3),
  approvals: ['Carol'],
  refusals: [],
  approvals_count: 1,
}

// Open proposals (dashboard / getProposals).
export const proposals: Proposal[] = [propAwaitingPayment, propReadyPayment, propAwaitingPayroll]

// ---- terminal (ledger-only) proposals ----

// SENT payment carrying the real mainnet txid.
const propSentPayment: Proposal = {
  id: 'prop-090',
  vault_id: 'demo',
  kind: 'payment',
  state: 'sent',
  proposer: 'Alice',
  value_zat: 8000000,
  value_zec: '0.0800',
  memo: 'pagamento fornecedor',
  to_address: beneficiaries[0]!.address,
  is_public: false,
  created_at: ago(6),
  txid: '43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572',
  approvals: ['Alice', 'Bob'],
  refusals: [],
  approvals_count: 2,
}

// SENT payroll (3 outputs) carrying a plausible txid.
const propSentPayroll: Proposal = {
  id: 'prop-091',
  vault_id: 'demo',
  kind: 'payroll',
  state: 'sent',
  proposer: 'Bob',
  value_zat: 21000000,
  value_zec: '0.2100',
  memo: 'folha de bolsas · abril',
  is_public: false,
  created_at: ago(12),
  txid: 'f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360',
  approvals: ['Bob', 'Carol'],
  refusals: [],
  approvals_count: 2,
}

// REFUSED payment.
const propRefused: Proposal = {
  id: 'prop-080',
  vault_id: 'demo',
  kind: 'payment',
  state: 'rejected',
  proposer: 'Carol',
  value_zat: 60000000,
  value_zec: '0.6000',
  memo: 'compra equipamento',
  to_address: beneficiaries[2]!.address,
  is_public: false,
  created_at: ago(9),
  approvals: [],
  refusals: ['Alice', 'Bob'],
  approvals_count: 0,
}

// EXPIRED payment (deadline passed with no quorum).
const propExpired: Proposal = {
  id: 'prop-081',
  vault_id: 'demo',
  kind: 'payment',
  state: 'expired',
  proposer: 'Alice',
  value_zat: 15000000,
  value_zec: '0.1500',
  memo: 'doação evento',
  to_address: beneficiaries[3]!.address,
  is_public: true,
  expiry_unix: ago(2),
  created_at: ago(5),
  approvals: ['Alice'],
  refusals: [],
  approvals_count: 1,
}

// Full ledger: terminal states + the still-open ones (matches the backend's list_all_proposals).
export const ledger: Proposal[] = [
  propAwaitingPayroll,
  propAwaitingPayment,
  propReadyPayment,
  propSentPayroll,
  propRefused,
  propSentPayment,
  propExpired,
]

// ---- payroll lines (per proposal, for the detail screen) ----

const payrollLinesAwaiting: PayrollLine[] = [
  { label: 'Bolsista · Ana', address: beneficiaries[3]!.address, value_zat: 10000000, value_zec: '0.1000', memo: 'bolsa maio', is_public: false },
  { label: 'Bolsista · João', address: beneficiaries[1]!.address, value_zat: 12000000, value_zec: '0.1200', memo: 'bolsa maio', is_public: false },
  { label: 'Bolsista · Rita', address: beneficiaries[2]!.address, value_zat: 8000000, value_zec: '0.0800', memo: 'bolsa maio', is_public: false },
]

const payrollLinesSent: PayrollLine[] = [
  { label: 'Bolsista · Ana', address: beneficiaries[3]!.address, value_zat: 7000000, value_zec: '0.0700', memo: 'bolsa abril', is_public: false },
  { label: 'Bolsista · João', address: beneficiaries[1]!.address, value_zat: 7000000, value_zec: '0.0700', memo: 'bolsa abril', is_public: false },
  { label: 'Bolsista · Rita', address: beneficiaries[2]!.address, value_zat: 7000000, value_zec: '0.0700', memo: 'bolsa abril', is_public: false },
]

const byId: Record<string, Proposal> = Object.fromEntries(
  [...proposals, propSentPayment, propSentPayroll, propRefused, propExpired].map((p) => [p.id, p]),
)

const linesById: Record<string, PayrollLine[]> = {
  'prop-103': payrollLinesAwaiting,
  'prop-091': payrollLinesSent,
}

/** A single open/terminal proposal by id (for getProposal). */
export function proposalById(id: string): Proposal | null {
  return byId[id] ?? null
}

/** Proposal detail with payroll lines ([] for a single payment). */
export function proposalDetail(id: string): { proposal: Proposal; lines: PayrollLine[] } | null {
  const proposal = byId[id]
  if (!proposal) return null
  return { proposal, lines: linesById[id] ?? [] }
}

/** Everything the DEMO fallback can serve, grouped for convenience. */
export const MOCK = {
  vault,
  vaults,
  balance,
  beneficiaries,
  proposals,
  ledger,
  proposalById,
  proposalDetail,
}
