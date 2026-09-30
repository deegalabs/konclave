import { useState } from 'react'
import { Letterhead } from '../components'
import { useI18n } from '../i18n'
import { useToast } from '../toast'
import { PROOF_RECORD_URL, PROOF_TXS, proofOriginCounts } from '../proof-record'
import '../proof.css'

// Judge-facing proof page: the browser equivalent of scripts/verify-proof.mjs. It shows each txid
// of the record with explorer links anyone can open, offers a client-side "verify on-chain now"
// check against a public explorer API, and states plainly what on-chain data can and cannot prove
// (mirrors docs/PROOF.md).
// Everything is client-side. The honest scope note is load-bearing: the chain proves the txs
// are real, mined and shielded, but a FROST-aggregated Orchard signature is indistinguishable
// on-chain from a single-signer one, so the threshold nature is attested off-chain (code + ceremony).
//
// THE LIST IS NOT KEPT HERE. It lived in this file as an array of eight, and this comment said
// "eight", while docs/PROOF.md grew to nineteen. It is `../proof-record` now, which a test holds to
// the table in docs/PROOF.md, and no count is written on this screen or in its comments.

type Locale = 'pt-BR' | 'en'

const explorerZec = (txid: string) => `https://mainnet.zcashexplorer.app/transactions/${txid}`
const explorerBlockchair = (txid: string) => `https://blockchair.com/zcash/transaction/${txid}`

const TXT = {
  'pt-BR': {
    eyebrow: 'Konclave · Prova',
    title: 'Confira nossa prova de mainnet',
    lead: 'Transações reais na mainnet do Zcash. Confira você mesmo, por exploradores públicos independentes. Nada aqui pede confiança cega.',
    txidLabel: 'ID da transação',
    blockLabel: 'Bloco',
    copy: 'Copiar',
    copied: 'Copiado',
    openZec: 'Abrir no zcashexplorer',
    openBlockchair: 'Abrir no Blockchair',
    verify: 'Verificar on-chain agora',
    verifying: 'Verificando…',
    reverify: 'Verificar de novo',
    found: 'Encontrada e minerada',
    confirmations: 'confirmações',
    confsUnknown: 'minerada (confirmações não informadas)',
    blockedShort: 'bloqueada',
    blockedHint: 'Verificação automática bloqueada - use os links do explorador abaixo',
    fallbackTitle: 'Verificação automática indisponível',
    fallback:
      'O navegador pode bloquear a chamada ao explorador (CORS). Isso não é uma falha da transação. Abra os links de explorador acima, ou rode `node scripts/verify-proof.mjs` para uma verificação independente.',
    scopeTitle: 'O que esta prova mostra (e o que não mostra)',
    scopeCan:
      'Os dados on-chain provam que a transação existe, foi minerada em um bloco e é blindada (Orchard, ou o pool Ironwood desde o NU6.3). Não revela valores nem partes, e essa ausência de detalhe é a privacidade funcionando.',
    scopeCannot:
      'Os dados on-chain NÃO provam, sozinhos, a natureza de limiar (t-de-n) do FROST. Uma assinatura Orchard agregada por FROST é indistinguível de uma assinatura de signatário único na cadeia, e essa indistinguibilidade é justamente a propriedade de privacidade. A natureza de limiar é atestada pelo código e pela cerimônia, fora da cadeia.',
    originDealer: 'Cofre dividido por um trusted dealer (a chave existiu inteira na criação)',
    originDkg: 'Cofre criado por DKG (a chave nunca existiu inteira)',
    scopeOrigin:
      'Como a chave de cada cofre foi feita também é algo que a cadeia não mostra. Das transações acima, {dealer} vieram de cofres divididos por um trusted dealer, em que a chave inteira existiu numa máquina na criação, e {dkg} vieram de cofres criados por DKG, em que a chave nunca existiu inteira. Cada cartão diz qual.',
    scopeRecord:
      'Esta lista é uma cópia da tabela em docs/PROOF.md, que é o registro. O registro diz, linha a linha, o que se apoia no bloco e o que se apoia na palavra de quem executou.',
    recordLink: 'Abrir o registro (docs/PROOF.md)',
  },
  en: {
    eyebrow: 'Konclave · Proof',
    title: 'Verify our mainnet proof yourself',
    lead: 'Real transactions on the Zcash mainnet. Confirm them yourself, through independent public explorers. Nothing here asks you to take it on faith.',
    txidLabel: 'Transaction ID',
    blockLabel: 'Block',
    copy: 'Copy',
    copied: 'Copied',
    openZec: 'Open on zcashexplorer',
    openBlockchair: 'Open on Blockchair',
    verify: 'Verify on-chain now',
    verifying: 'Verifying…',
    reverify: 'Verify again',
    found: 'Found and mined',
    confirmations: 'confirmations',
    confsUnknown: 'mined (confirmations not reported)',
    blockedShort: 'blocked',
    blockedHint: 'Automatic check blocked - use the explorer links below',
    fallbackTitle: 'Automatic check unavailable',
    fallback:
      'The browser may block the explorer call (CORS). That is not a failure of the transaction. Open the explorer links above, or run `node scripts/verify-proof.mjs` for an independent check.',
    scopeTitle: 'What this proof shows (and what it does not)',
    scopeCan:
      'On-chain data proves the transaction exists, is mined in a block, and is shielded (Orchard, or the Ironwood pool since NU6.3). It reveals nothing about amounts or parties, and that absence of detail is the privacy working as intended.',
    scopeCannot:
      'On-chain data does NOT, by itself, prove the threshold (t-of-n) FROST nature. A FROST-aggregated Orchard signature is indistinguishable on-chain from a single-signer one, and that indistinguishability is precisely the privacy property. The threshold nature is attested by the code and the ceremony, off-chain.',
    originDealer: 'Vault split by a trusted dealer (the whole key existed at creation)',
    originDkg: 'Vault created by DKG (the key was never whole)',
    scopeOrigin:
      'How the key of each vault was made is also something the chain cannot show. Of the transactions above, {dealer} came from vaults split by a trusted dealer, where the whole key existed on one machine at creation, and {dkg} came from vaults created by DKG, where the key was never whole. Each card says which.',
    scopeRecord:
      'This list is a copy of the table in docs/PROOF.md, which is the record. The record says, row by row, what rests on the block and what rests on the word of whoever ran it.',
    recordLink: 'Open the record (docs/PROOF.md)',
  },
}

// Rich text: renders `code` spans inside a plain string (used for the fallback message).
function rich(s: string) {
  return s.split(/(`[^`]+`)/g).map((p, i) =>
    p.startsWith('`') && p.endsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : <span key={i}>{p}</span>,
  )
}

type CheckState =
  | { s: 'idle' }
  | { s: 'checking' }
  | { s: 'found'; confirmations: number | null }
  | { s: 'blocked' } // fetch/CORS/network error; never a false failure

// Query Blockchair's public dashboards API for one txid. Returns a normalized result, or throws
// on any network/CORS error (the caller treats a throw as "blocked", not as "not found").
async function checkBlockchair(txid: string): Promise<{ found: boolean; confirmations: number | null }> {
  const url = `https://api.blockchair.com/zcash/dashboards/transaction/${txid}`
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  const data = json?.data?.[txid]
  const tx = data?.transaction
  const blockId = typeof tx?.block_id === 'number' ? tx.block_id : null
  const mined = blockId !== null && blockId > 0
  const state = typeof json?.context?.state === 'number' ? json.context.state : null
  const confirmations = mined && state && state > 0 ? state - blockId + 1 : null
  return { found: mined, confirmations }
}

export default function Proof() {
  const { locale } = useI18n()
  const toast = useToast()
  const loc = (locale as Locale) in TXT ? (locale as Locale) : 'en'
  const T = TXT[loc]

  const [checks, setChecks] = useState<Record<string, CheckState>>({})

  const origins = proofOriginCounts()
  const scopeOrigin = T.scopeOrigin
    .replace('{dealer}', String(origins.dealer))
    .replace('{dkg}', String(origins.dkg))

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)
    toast.ok(T.copied)
  }

  // Verify every txid. On ANY error (CORS is the common one in a browser), the check resolves to
  // 'blocked' and the calm fallback is shown; we never render a false failure.
  //
  // One after the other, not all at once. The list was eight when this fired them together; a
  // public explorer answers a burst the size of the whole record by refusing part of it, and a
  // refusal reads here as "blocked" for a transaction that is perfectly fine.
  const verifyAll = async () => {
    setChecks(Object.fromEntries(PROOF_TXS.map((t) => [t.txid, { s: 'checking' as const }])))
    for (const t of PROOF_TXS) {
      let next: CheckState
      try {
        const r = await checkBlockchair(t.txid)
        next = r.found ? { s: 'found', confirmations: r.confirmations } : { s: 'blocked' }
      } catch {
        next = { s: 'blocked' }
      }
      setChecks((prev) => ({ ...prev, [t.txid]: next }))
    }
  }

  const anyState = PROOF_TXS.map((t) => checks[t.txid]?.s)
  const isChecking = anyState.some((s) => s === 'checking')
  const hasRun = anyState.some((s) => s && s !== 'idle')
  const anyBlocked = anyState.some((s) => s === 'blocked')

  return (
    <div className="proof">
      <Letterhead />
      <main className="proof-main">
        <article className="proof-col">
          <span className="proof-eyebrow">{T.eyebrow}</span>
          <h1 className="proof-title">{T.title}</h1>
          <p className="proof-lead">{T.lead}</p>

          <div className="proof-actions">
            <button type="button" className="proof-verify" onClick={() => void verifyAll()} disabled={isChecking}>
              {isChecking ? T.verifying : hasRun ? T.reverify : T.verify}
            </button>
          </div>

          <div className="proof-cards">
            {PROOF_TXS.map((t) => {
              const st = checks[t.txid] ?? { s: 'idle' as const }
              return (
                <section className="proof-card" key={t.txid}>
                  <p className="proof-card-label">{t.label[loc]}</p>

                  <span className="proof-field-label">{T.txidLabel}</span>
                  <div className="proof-txid-row">
                    <code className="proof-txid">{t.txid}</code>
                    <button
                      type="button"
                      className="proof-copy"
                      onClick={() => copy(t.txid)}
                      aria-label={T.copy}
                    >
                      {T.copy}
                    </button>
                  </div>

                  <div className="proof-meta">
                    <span className="proof-block">
                      {T.blockLabel} <strong>{t.block.toLocaleString(loc === 'pt-BR' ? 'pt-BR' : 'en-US')}</strong>
                    </span>
                    <span className="proof-block">{t.origin === 'dealer' ? T.originDealer : T.originDkg}</span>
                    <ProofStatus st={st} T={T} />
                  </div>

                  <div className="proof-links">
                    <a className="proof-link" href={explorerZec(t.txid)} target="_blank" rel="noreferrer noopener">
                      {T.openZec}
                    </a>
                    <a
                      className="proof-link"
                      href={explorerBlockchair(t.txid)}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {T.openBlockchair}
                    </a>
                  </div>
                </section>
              )
            })}
          </div>

          {anyBlocked && (
            <aside className="proof-fallback" role="status">
              <span className="proof-fallback-title">{T.fallbackTitle}</span>
              <p>{rich(T.fallback)}</p>
            </aside>
          )}

          <section className="proof-scope" aria-label={T.scopeTitle}>
            <h2 className="proof-scope-title">{T.scopeTitle}</h2>
            <p className="proof-scope-can">{T.scopeCan}</p>
            <p className="proof-scope-cannot">{T.scopeCannot}</p>
            <p className="proof-scope-can">{scopeOrigin}</p>
            <p className="proof-scope-can">{T.scopeRecord}</p>
            <div className="proof-links">
              <a className="proof-link" href={PROOF_RECORD_URL} target="_blank" rel="noreferrer noopener">
                {T.recordLink}
              </a>
            </div>
          </section>
        </article>
      </main>
    </div>
  )
}

function ProofStatus({ st, T }: { st: CheckState; T: (typeof TXT)['en'] }) {
  if (st.s === 'idle') return null
  if (st.s === 'checking') return <span className="proof-status checking">{T.verifying}</span>
  if (st.s === 'blocked') return <span className="proof-status blocked" title={T.blockedHint} aria-label={T.blockedHint}>{T.blockedShort}</span>
  // found
  return (
    <span className="proof-status found">
      {st.confirmations !== null
        ? `${T.found} · ${st.confirmations.toLocaleString('en-US')} ${T.confirmations}`
        : T.confsUnknown}
    </span>
  )
}
