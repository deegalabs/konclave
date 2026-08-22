// Approvals (K10, ADR-0009, GSP IA #159): the vault's GOVERNANCE hub - proposals and the signing
// evidence that back them. The Ledger is NOT here: it is the accountant's book, a destination in its
// own right, promoted to a top-level VAULT rail item. Each tab embeds its existing screen unchanged
// (via the `embedded` prop, which drops the per-screen chrome).

import { useState } from 'react'
import { PageHeader } from '../page'
import { useT } from '../i18n'
import Proposals from './Proposals'
import Ceremonies from './Ceremonies'

type Tab = 'proposals' | 'evidence'
const TABS: Tab[] = ['proposals', 'evidence']

export default function Activity() {
  const t = useT()
  const [tab, setTab] = useState<Tab>('proposals')

  return (
    <main className="page">
      <PageHeader eyebrow={t('activity.eyebrow')} title={t('activity.title')} subtitle={t('activity.subtitle')} />

      <div className="acts" role="tablist" aria-label={t('activity.title')}>
        {TABS.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={'act-tab' + (tab === k ? ' on' : '')}
            onClick={() => setTab(k)}
          >
            {t('activity.tab.' + k)}
          </button>
        ))}
      </div>

      <div className="act-body">
        {tab === 'proposals' && <Proposals embedded />}
        {tab === 'evidence' && <Ceremonies embedded />}
      </div>
    </main>
  )
}
