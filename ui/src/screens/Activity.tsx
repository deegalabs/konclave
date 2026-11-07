// Approvals (K10, ADR-0009, GSP IA #159): the vault's GOVERNANCE hub - proposals and the signing
// evidence that back them. The Ledger is NOT here: it is the accountant's book, a destination in its
// own right, promoted to a top-level VAULT rail item. Each tab embeds its existing screen unchanged
// (via the `embedded` prop, which drops the per-screen chrome).

import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { PageHeader } from '../page'
import { useT } from '../i18n'
import Proposals from './Proposals'
import Ceremonies from './Ceremonies'
import SinceLast from './SinceLast'

type Tab = 'proposals' | 'since' | 'evidence'
const TABS: Tab[] = ['proposals', 'since', 'evidence']

export default function Activity() {
  const t = useT()
  // A caller may ask for a tab (the sent proposal points at its evidence): read it once, from state.
  const loc = useLocation() as { state?: { tab?: Tab } }
  const [tab, setTab] = useState<Tab>(loc.state?.tab === 'evidence' ? 'evidence' : 'proposals')

  return (
    <main className="page">
      <PageHeader eyebrow={t('activity.eyebrow')} title={t('activity.title')} subtitle={t('activity.subtitle')} />

      {/* The tab pattern as the ARIA practices describe it: one Tab stop (roving tabindex), arrows
          move between tabs, each tab names its panel. */}
      <div className="acts" role="tablist" aria-label={t('activity.title')}
        onKeyDown={(e) => {
          const i = TABS.indexOf(tab)
          const to = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i - 1 + TABS.length) % TABS.length] : e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS[TABS.length - 1] : null
          if (!to) return
          e.preventDefault(); setTab(to)
          ;(e.currentTarget.querySelector<HTMLElement>(`#act-tab-${to}`))?.focus()
        }}>
        {TABS.map((k) => (
          <button
            key={k}
            id={`act-tab-${k}`}
            role="tab"
            aria-selected={tab === k}
            aria-controls="act-panel"
            tabIndex={tab === k ? 0 : -1}
            className={'act-tab' + (tab === k ? ' on' : '')}
            onClick={() => setTab(k)}
          >
            {t('activity.tab.' + k)}
          </button>
        ))}
      </div>

      <div className="act-body" role="tabpanel" id="act-panel" aria-labelledby={`act-tab-${tab}`}>
        {tab === 'proposals' && <Proposals embedded />}
        {tab === 'since' && <SinceLast />}
        {tab === 'evidence' && <Ceremonies embedded />}
      </div>
    </main>
  )
}
