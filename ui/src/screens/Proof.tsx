import { useState } from 'react'
import { Letterhead } from '../components'
import { useI18n } from '../i18n'
import '../proof.css'

// Judge-facing proof page. Konclave claims two REAL Zcash mainnet transactions; this screen
// is the browser equivalent of scripts/verify-proof.mjs. It shows each txid with explorer links
// anyone can open, offers a client-side "verify on-chain now" check against a public explorer
// API, and states plainly what on-chain data can and cannot prove (mirrors docs/PROOF.md).
// Everything is client-side. The honest scope note is load-bearing: the chain proves the txs
// are real, mined and shielded, but a FROST-aggregated Orchard signature is indistinguishable
// on-chain from a single-signer one, so the 2-of-3 nature is attested off-chain (code + ceremony).

type Locale = 'pt-BR' | 'en'

// The two mainnet transactions. Block heights are the known, on-chain heights.
const TXS = [
  {
    txid: '43433a109d3f2a078c0a9269ccb156392ade7a1f7ac1532981611eda1e59a572',
    block: 3397342,
    kind: 'app' as const,
  },
  {
    txid: 'f63ee64d7bc086a8286631d03936ec2ca2ca57f4e4c63712fc95c1f02c522360',
    block: 3396616,
    kind: 'slice' as const,
  },
]

const explorerZec = (txid: string) => `https://mainnet.zcashexplorer.app/transactions/${txid}`
const explorerBlockchair = (txid: string) => `https://blockchair.com/zcash/transaction/${txid}`

const TXT = {
  'pt-BR': {
    eyebrow: 'Konclave · Prova',
    title: 'Confira nossa prova de mainnet',
    lead: 'Duas transações reais na mainnet do Zcash. Confira você mesmo, por exploradores públicos independentes. Nada aqui pede confiança cega.',
    labelApp: 'Pagamento por quórum 2-de-3 conduzido pelo app (assinado por FROST, transmitido)',
    labelSlice: 'Pagamento do Gate 1, fatia vertical pela CLI',
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
    fallbackTitle: 'Verificação automática indisponível',
    fallback:
      'O navegador pode bloquear a chamada ao explorador (CORS). Isso não é uma falha da transação. Abra os links de explorador acima, ou rode `node scripts/verify-proof.mjs` para uma verificação independente.',
    scopeTitle: 'O que esta prova mostra (e o que não mostra)',
    scopeCan:
      'Os dados on-chain provam que a transação existe, foi minerada em um bloco e é blindada (Orchard). Não revela valores nem partes, e essa ausência de detalhe é a privacidade funcionando.',
    scopeCannot:
      'Os dados on-chain NÃO provam, sozinhos, a natureza 2-de-3 (FROST). Uma assinatura Orchard agregada por FROST é indistinguível de uma assinatura de signatário único na cadeia, e essa indistinguibilidade é justamente a propriedade de privacidade. A natureza de limiar é atestada pelo código e pela cerimônia, fora da cadeia.',
  },
  en: {
    eyebrow: 'Konclave · Proof',
    title: 'Verify our mainnet proof yourself',
    lead: 'Two real transactions on the Zcash mainnet. Confirm them yourself, through independent public explorers. Nothing here asks you to take it on faith.',
    labelApp: 'Application-driven 2-of-3 quorum payment (FROST-signed, broadcast)',
    labelSlice: 'Gate-1 CLI-driven vertical-slice payment',
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
    fallbackTitle: 'Automatic check unavailable',
    fallback:
      'The browser may block the explorer call (CORS). That is not a failure of the transaction. Open the explorer links above, or run `node scripts/verify-proof.mjs` for an independent check.',
    scopeTitle: 'What this proof shows (and what it does not)',
    scopeCan:
      'On-chain data proves the transaction exists, is mined in a block, and is shielded (Orchard). It reveals nothing about amounts or parties, and that absence of detail is the privacy working as intended.',
    scopeCannot:
      'On-chain data does NOT, by itself, prove the 2-of-3 FROST nature. A FROST-aggregated Orchard signature is indistinguishable on-chain from a single-signer one, and that indistinguishability is precisely the privacy property. The threshold nature is attested by the code and the ceremony, off-chain.',
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
  const loc = (locale as Locale) in TXT ? (locale as Locale) : 'en'
  const T = TXT[loc]

  const [checks, setChecks] = useState<Record<string, CheckState>>({})
  const [copied, setCopied] = useState<string | null>(null)

  const labelFor = (kind: 'app' | 'slice') => (kind === 'app' ? T.labelApp : T.labelSlice)

  const copy = (text: string, tag: string) => {
    void navigator.clipboard?.writeText(text)
    setCopied(tag)
    setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1600)
  }

  // Verify every txid at once. On ANY error (CORS is the common one in a browser), the check
  // resolves to 'blocked' and the calm fallback is shown; we never render a false failure.
  const verifyAll = () => {
    setChecks(Object.fromEntries(TXS.map((t) => [t.txid, { s: 'checking' as const }])))
    TXS.forEach((t) => {
      checkBlockchair(t.txid)
        .then((r) => {
          setChecks((prev) => ({
            ...prev,
            [t.txid]: r.found ? { s: 'found', confirmations: r.confirmations } : { s: 'blocked' },
          }))
        })
        .catch(() => {
          setChecks((prev) => ({ ...prev, [t.txid]: { s: 'blocked' } }))
        })
    })
  }

  const anyState = TXS.map((t) => checks[t.txid]?.s)
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
            <button type="button" className="proof-verify" onClick={verifyAll} disabled={isChecking}>
              {isChecking ? T.verifying : hasRun ? T.reverify : T.verify}
            </button>
          </div>

          <div className="proof-cards">
            {TXS.map((t) => {
              const st = checks[t.txid] ?? { s: 'idle' as const }
              return (
                <section className="proof-card" key={t.txid}>
                  <p className="proof-card-label">{labelFor(t.kind)}</p>

                  <span className="proof-field-label">{T.txidLabel}</span>
                  <div className="proof-txid-row">
                    <code className="proof-txid">{t.txid}</code>
                    <button
                      type="button"
                      className="proof-copy"
                      onClick={() => copy(t.txid, t.txid)}
                      aria-label={T.copy}
                    >
                      {copied === t.txid ? T.copied : T.copy}
                    </button>
                  </div>

                  <div className="proof-meta">
                    <span className="proof-block">
                      {T.blockLabel} <strong>{t.block.toLocaleString(loc === 'pt-BR' ? 'pt-BR' : 'en-US')}</strong>
                    </span>
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
          </section>
        </article>
      </main>
    </div>
  )
}

function ProofStatus({ st, T }: { st: CheckState; T: (typeof TXT)['en'] }) {
  if (st.s === 'idle') return null
  if (st.s === 'checking') return <span className="proof-status checking">{T.verifying}</span>
  if (st.s === 'blocked') return <span className="proof-status blocked">…</span>
  // found
  return (
    <span className="proof-status found">
      {st.confirmations !== null
        ? `${T.found} · ${st.confirmations.toLocaleString('en-US')} ${T.confirmations}`
        : T.confsUnknown}
    </span>
  )
}
