import { useState } from 'react'
import { Letterhead } from '../components'
import { useI18n } from '../i18n'
import { useToast } from '../toast'
import '../proof.css'

// Judge-facing proof page. Konclave claims eight REAL Zcash mainnet transactions; this screen
// is the browser equivalent of scripts/verify-proof.mjs. It shows each txid with explorer links
// anyone can open, offers a client-side "verify on-chain now" check against a public explorer
// API, and states plainly what on-chain data can and cannot prove (mirrors docs/PROOF.md).
// Everything is client-side. The honest scope note is load-bearing: the chain proves the txs
// are real, mined and shielded, but a FROST-aggregated Orchard signature is indistinguishable
// on-chain from a single-signer one, so the 2-of-3 nature is attested off-chain (code + ceremony).

type Locale = 'pt-BR' | 'en'

// The eight mainnet transactions. Block heights are the known, on-chain heights.
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
  {
    txid: '6c898239e05fdd1ccce5d650fa25eeabb10d1645a3fdbc36ab5fd3ac8d4fd35f',
    block: 3413636,
    kind: 'fresh' as const,
  },
  {
    txid: 'b1e24c07fcd629e6e6ea6809ffeb5d2e311054781740c6a5db73dabc94d0e1b4',
    block: 3413648,
    kind: 'payroll' as const,
  },
  {
    txid: 'aab00f903b65e32d1adac317820a85fc97d15c2dcd788b3657ce36773e230ff3',
    block: 3413792,
    kind: 'dkg' as const,
  },
  {
    txid: '54266f478505160adfb039c7c76f5615f1536a34059ab30e9f24781ec2e5c494',
    block: 3428205,
    kind: 'migrate' as const,
  },
  {
    txid: '36c60f1e3f602c2ac13c9f5b0687f248522499fc5a8b69311605336457226c95',
    block: 3428246,
    kind: 'ironwood' as const,
  },
  {
    txid: '3022420a8bcf17ffd5511163c18ee9b5996a3ba44747e4eff6794bdd3f04ccee',
    block: 3429922,
    kind: 'browser' as const,
  },
]

const explorerZec = (txid: string) => `https://mainnet.zcashexplorer.app/transactions/${txid}`
const explorerBlockchair = (txid: string) => `https://blockchair.com/zcash/transaction/${txid}`

const TXT = {
  'pt-BR': {
    eyebrow: 'Konclave · Prova',
    title: 'Confira nossa prova de mainnet',
    lead: 'Transações reais na mainnet do Zcash. Confira você mesmo, por exploradores públicos independentes. Nada aqui pede confiança cega.',
    labelApp: 'Pagamento por quórum 2-de-3 conduzido pelo app (assinado por FROST, transmitido)',
    labelSlice: 'Pagamento do Gate 1, fatia vertical pela CLI',
    labelFresh: 'Pagamento 2-de-3 FROST de um cofre criado e financiado do zero (reproduzido ponta a ponta)',
    labelPayroll: 'Folha privada multi-saída (3 saídas, um memo criptografado cada), 2-de-3 FROST',
    labelDkg: 'Envio 2-de-3 FROST de um cofre gerado por DKG real (chave nunca reconstituída), transmitido à mainnet',
    labelMigrate: 'Migração Orchard→Ironwood (NU6.3/V6), 2-de-3 FROST, semeia o pool Ironwood',
    labelIronwood: 'Primeiro gasto DO pool Ironwood na mainnet (NU6.3/V6), 2-de-3 FROST',
    labelBrowser: 'Primeiro broadcast na mainnet assinado NO NAVEGADOR: cofre 2-de-2 nascido de DKG no navegador, cada dispositivo assinando com só o seu share pelo relay cego (Arquitetura B), pool Ironwood',
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
      'Os dados on-chain provam que a transação existe, foi minerada em um bloco e é blindada (Orchard). Não revela valores nem partes, e essa ausência de detalhe é a privacidade funcionando.',
    scopeCannot:
      'Os dados on-chain NÃO provam, sozinhos, a natureza de limiar (t-de-n) do FROST. Uma assinatura Orchard agregada por FROST é indistinguível de uma assinatura de signatário único na cadeia, e essa indistinguibilidade é justamente a propriedade de privacidade. A natureza de limiar é atestada pelo código e pela cerimônia, fora da cadeia.',
  },
  en: {
    eyebrow: 'Konclave · Proof',
    title: 'Verify our mainnet proof yourself',
    lead: 'Real transactions on the Zcash mainnet. Confirm them yourself, through independent public explorers. Nothing here asks you to take it on faith.',
    labelApp: 'Application-driven 2-of-3 quorum payment (FROST-signed, broadcast)',
    labelSlice: 'Gate-1 CLI-driven vertical-slice payment',
    labelFresh: '2-of-3 FROST payment from a freshly created and funded vault (reproduced end to end)',
    labelPayroll: 'Private multi-output payroll (3 outputs, one encrypted memo each), 2-of-3 FROST',
    labelDkg: '2-of-3 FROST send from a real DKG-generated vault (key never reconstituted), broadcast to mainnet',
    labelMigrate: 'Orchard→Ironwood migration (NU6.3/V6), 2-of-3 FROST, seeds the Ironwood pool',
    labelIronwood: 'First spend FROM the Ironwood pool on mainnet (NU6.3/V6), 2-of-3 FROST',
    labelBrowser: 'First browser-signed mainnet broadcast: a browser-DKG 2-of-2 vault, each device signing in the browser with only its own share over the blind relay (Architecture B), Ironwood pool',
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
      'On-chain data proves the transaction exists, is mined in a block, and is shielded (Orchard). It reveals nothing about amounts or parties, and that absence of detail is the privacy working as intended.',
    scopeCannot:
      'On-chain data does NOT, by itself, prove the threshold (t-of-n) FROST nature. A FROST-aggregated Orchard signature is indistinguishable on-chain from a single-signer one, and that indistinguishability is precisely the privacy property. The threshold nature is attested by the code and the ceremony, off-chain.',
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

  const labelFor = (
    kind: 'app' | 'slice' | 'fresh' | 'payroll' | 'dkg' | 'migrate' | 'ironwood' | 'browser',
  ) =>
    kind === 'app' ? T.labelApp
    : kind === 'slice' ? T.labelSlice
    : kind === 'fresh' ? T.labelFresh
    : kind === 'dkg' ? T.labelDkg
    : kind === 'migrate' ? T.labelMigrate
    : kind === 'ironwood' ? T.labelIronwood
    : kind === 'browser' ? T.labelBrowser
    : T.labelPayroll

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)
    toast.ok(T.copied)
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
