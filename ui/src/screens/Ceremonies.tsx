import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { PageHeader, PageFooter } from '../page'
import { Loading, Secret } from '../components'
import { useT, useI18n } from '../i18n'
import { getSelectedVault, getLedger, type Proposal } from '../api'
import { vaultCeremonies, type CeremonyRecord } from '../helper'
import { fmtDate, fmtZec, shortAddr } from '../format'
import { useLoading } from '../loading'

/**
 * /ceremonies - the vault's signing evidence trail, inside the vault shell (redesign #6.4). This
 * moved out of /net: the ceremony record is auditable, read-only governance data, so it belongs in
 * the app (next to the ledger), not on the ceremony screen. Reproducible evidence of every payment
 * the vault signed: the sighash, the quorum's aggregate signature, and the on-chain txid.
 */
export default function Ceremonies({ embedded = false }: { embedded?: boolean }) {
  const t = useT()
  const { locale } = useI18n()
  const { begin, end } = useLoading()
  const [records, setRecords] = useState<CeremonyRecord[] | null>(null)
  // The proposals, so a record that reached the chain can name the payment it signed (same txid).
  // The join is on the screen only: the record carries no proposal id (#290).
  const [byTxid, setByTxid] = useState<Map<string, Proposal>>(new Map())
  const loc = useLocation() as { state?: { txid?: string } }
  const hilite = loc.state?.txid
  const hiliteRef = useRef<HTMLLIElement>(null)
  // Arriving from a proposal: land on its record (focus scrolls it into view and a reader says it).
  useEffect(() => { if (records && hilite) hiliteRef.current?.focus() }, [records, hilite])
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    let on = true
    begin()
    void (async () => {
      try {
        const id = getSelectedVault()
        if (!id) { if (on) setBusy(false); return }
        const [r, ps] = await Promise.all([vaultCeremonies(id), getLedger()])
        if (on) {
          setRecords(r)
          setByTxid(new Map((ps ?? []).filter((p) => p.txid).map((p) => [p.txid as string, p])))
          setBusy(false)
        }
      } finally {
        end()
      }
    })()
    return () => { on = false }
  }, [begin, end])

  const list = (
      <ul className="cer-list mt" role="list">
        {busy && <Loading />}
        {!busy && (!records || records.length === 0) && (
          <p className="hint">{t('ceremonies.empty')}</p>
        )}
        {records && records.map((c, i) => {
          const p = c.txid ? byTxid.get(c.txid) : undefined
          const doc = p ? (p.memo || (p.kind === 'payroll' ? t('kind.payroll') : t('kind.payment'))) : ''
          const here = !!hilite && c.txid === hilite
          return (
          <li key={i} className={'cer-row' + (here ? ' hilite' : '')} tabIndex={here ? -1 : undefined} ref={here ? hiliteRef : undefined} aria-current={here ? 'true' : undefined}>
            <div className="cer-head">
              <span className={c.dry_run ? 'cer-tag' : 'cer-tag live'}>
                {c.dry_run ? t('ceremonies.dryRun') : t('ceremonies.broadcast')}
              </span>
              <span className="cer-when">{fmtDate(c.created_at_unix, locale)}</span>
              {here && <span className="cer-tag this">{t('ceremonies.thisPayment')}</span>}
            </div>
            {/* What this signature paid: the proposal with the same txid, in the treasurer's words. */}
            {c.txid && (p ? (
              <div className="cer-pay">
                <span className="cer-doc">{doc}</span>
                <Secret sm><b>{fmtZec(p.value_zec)} ZEC</b></Secret>
                <Link className="link" to="/proposal" state={{ id: p.id }} aria-label={`${t('ceremonies.viewProposal')} ${doc}`}>{t('ceremonies.viewProposal')}</Link>
              </div>
            ) : (
              <div className="cer-nomatch dim">{t('ceremonies.noProposal')}</div>
            ))}
            {/* The receipt: what a member cares about - was it sent, and where to see it on-chain. */}
            {c.txid ? (
              <div className="cer-receipt">
                <code className="cer-txid">{shortAddr(c.txid, 10, 8)}</code>
                <a className="link" href={`https://mainnet.zcashexplorer.app/transactions/${c.txid}`} target="_blank" rel="noreferrer">{t('ceremonies.viewOnChain')} ↗</a>
              </div>
            ) : (
              <div className="hint dim">{t('ceremonies.dryRunNote')}</div>
            )}
            {/* The cryptographic proof is kept for the auditor, behind a disclosure (§7). */}
            <details className="cer-tech">
              <summary>{t('ceremonies.techDetails')}</summary>
              <div className="cer-kv"><span className="cer-k">{t('ceremonies.sighash')}</span><code>{shortAddr(c.sighash, 10, 8)}</code></div>
              <div className="cer-kv">
                <span className="cer-k">{t('ceremonies.signature')}</span>
                <code>{c.signatures.map((s) => shortAddr(s, 8, 6)).join(', ') || '-'}</code>
              </div>
            </details>
          </li>
          )
        })}
      </ul>
  )

  if (embedded) return list

  return (
    <main className="page">
      <PageHeader
        eyebrow={t('ceremonies.eyebrow')}
        title={t('ceremonies.title')}
        subtitle={t('ceremonies.subtitle')}
      />
      {list}
      <PageFooter>{t('ceremonies.footer')}</PageFooter>
    </main>
  )
}
