// Activity (K10, ADR-0009): one in-vault destination for the whole proposal lifecycle, replacing
// three separate rail items (Proposals + Ledger + Ceremonies). Each is embedded as a tab, reusing
// its existing screen unchanged (via the `embedded` prop, which drops the per-screen chrome).

import { useState } from 'react'
import { PageHeader, NextStep } from '../page'
import { useT } from '../i18n'
import Proposals from './Proposals'
import Ledger from './Ledger'
import Ceremonies from './Ceremonies'

type Tab = 'proposals' | 'ledger' | 'evidence'
const TABS: Tab[] = ['proposals', 'ledger', 'evidence']

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
        {tab === 'ledger' && <Ledger embedded />}
        {tab === 'evidence' && <Ceremonies embedded />}
      </div>

      <NextStep label={t('next.label')} cta={t('next.dashboard')} to="/dashboard" />
    </main>
  )
}
