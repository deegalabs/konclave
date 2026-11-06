import { useEffect, useRef, useState } from 'react'
import { SkeletonRows } from '../skeleton'
import { Link, useLocation } from 'react-router-dom'
import { PageHeader, PageFooter } from '../page'
import { Secret } from '../components'
import ReadState from '../ReadState'
import { lastReadFailure } from '../read-failure'
import { useT, useI18n } from '../i18n'
import { getSelectedVault, getLedger, type Proposal } from '../api'
import { vaultCeremonies, type CeremonyRecord } from '../helper'
import { useVaultReadable } from '../vault-readable'
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
  // Whether the ledger was read at all: "no proposal carries this transaction" is a claim about the
  // vault's books, and it is only made from a ledger that answered. A null keeps the last good map.
  const [ledgerRead, setLedgerRead] = useState(false)
  const loc = useLocation() as { state?: { txid?: string } }
  const hilite = loc.state?.txid
  const hiliteRef = useRef<HTMLLIElement>(null)
  // Arriving from a proposal: land on its record (focus scrolls it into view and a reader says it).
  useEffect(() => { if (records && hilite) hiliteRef.current?.focus() }, [records, hilite])
  const [busy, setBusy] = useState(true)
  // A list that could not be read is said as such, never as "no ceremonies recorded yet" (#320).
  const [attempt, setAttempt] = useState(0)
  const [retrying, setRetrying] = useState(false)
  // Locked: the records would 401 and read as a failure. Nothing is read until the passphrase lands (#439).
  const readable = useVaultReadable()

  useEffect(() => {
    if (!readable) return
    let on = true
    begin()
    void (async () => {
      try {
        const id = getSelectedVault()
        if (!id) { if (on) setBusy(false); return }
        const [r, ps] = await Promise.all([vaultCeremonies(id), getLedger()])
        if (on) {
          setRecords(r)
          if (ps) { setByTxid(new Map(ps.filter((p) => p.txid).map((p) => [p.txid as string, p]))); setLedgerRead(true) }
          setBusy(false)
        }
      } finally {
        end()
      }
    })()
    return () => { on = false }
    // Once it is readable: the loading hooks are stable in the app, and listing them re-ran the read
    // on every render where they are not (tests), which took the read state away from under its retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readable])

  // The retry reads again from the start; a retry that fails again is said again (ReadState).
  const retry = async () => {
    const id = getSelectedVault()
    if (!id) return
    setRetrying(true)
    try {
      const [r, ps] = await Promise.all([vaultCeremonies(id), getLedger()])
      setRecords(r)
      if (ps) { setByTxid(new Map(ps.filter((p) => p.txid).map((p) => [p.txid as string, p]))); setLedgerRead(true) }
      if (r === null) setAttempt((a) => a + 1)
    } finally {
      setRetrying(false)
    }
  }
  const unread = !busy && records === null && lastReadFailure('/api/vault/ceremonies')

  const list = (
    <>
      {/* Outside the list: a list may hold only its items, and a reader hides anything else in it. */}
      {unread && (
        <ReadState title={t('ceremonies.unreadTitle')} failure={unread} attempt={attempt} busy={retrying} onRetry={() => void retry()} />
      )}
      {busy && <SkeletonRows n={3} className="mt" />}
      {!busy && !unread && (!records || records.length === 0) && (
        <p className="hint">{t('ceremonies.empty')}</p>
      )}
      {/* The list only when it has items: an empty list is still announced as one. */}
      {records && records.length > 0 && (
      <ul className="cer-list mt" role="list">
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
            ) : ledgerRead ? (
              <div className="cer-nomatch dim">{t('ceremonies.noProposal')}</div>
            ) : null)}
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
      )}
    </>
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
