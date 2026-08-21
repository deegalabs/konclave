import { useEffect, useState } from 'react'
import { PageHeader, PageFooter, NextStep } from '../page'
import { Loading } from '../components'
import { useT, useI18n } from '../i18n'
import { getSelectedVault } from '../api'
import { vaultCeremonies, type CeremonyRecord } from '../helper'
import { fmtDate, shortAddr } from '../format'
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
  const [busy, setBusy] = useState(true)

  useEffect(() => {
    let on = true
    begin()
    void (async () => {
      try {
        const id = getSelectedVault()
        if (!id) { if (on) setBusy(false); return }
        const r = await vaultCeremonies(id)
        if (on) { setRecords(r); setBusy(false) }
      } finally {
        end()
      }
    })()
    return () => { on = false }
  }, [begin, end])

  const list = (
      <div className="cer-list mt">
        {busy && <Loading />}
        {!busy && (!records || records.length === 0) && (
          <p className="hint">{t('ceremonies.empty')}</p>
        )}
        {records && records.map((c, i) => (
          <div key={i} className="cer-row">
            <div className="cer-head">
              <span className={c.dry_run ? 'cer-tag' : 'cer-tag live'}>
                {c.dry_run ? t('ceremonies.dryRun') : t('ceremonies.broadcast')}
              </span>
              <span className="cer-when">{fmtDate(c.created_at_unix, locale)}</span>
            </div>
            {c.txid && (
              <div className="cer-kv"><span className="cer-k">txid</span><code>{c.txid}</code></div>
            )}
            <div className="cer-kv"><span className="cer-k">sighash</span><code>{shortAddr(c.sighash, 10, 8)}</code></div>
            <div className="cer-kv">
              <span className="cer-k">{t('ceremonies.signature')}</span>
              <code>{c.signatures.map((s) => shortAddr(s, 8, 6)).join(', ') || '-'}</code>
            </div>
          </div>
        ))}
      </div>
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
      <NextStep label={t('next.label')} cta={t('ceremonies.next')} to="/ledger" />
      <PageFooter>{t('ceremonies.footer')}</PageFooter>
    </main>
  )
}
