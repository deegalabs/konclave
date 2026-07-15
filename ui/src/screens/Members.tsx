import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Seal } from '../components'
import { PageHeader, PageFooter } from '../page'
import { Identicon } from '../avatar'
import { useT, useTr } from '../i18n'
import { getVault, health, shortAddr, type Vault } from '../api'

const ME = 'Alice' // this device acts as the coordinator member (single-device demo)

export default function Members() {
  const t = useT()
  const tr = useTr()
  const nav = useNavigate()
  const [vault, setVault] = useState<Vault | null>(null)
  const [live, setLive] = useState<boolean | null>(null)

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      if (ok) { const v = await getVault(); if (on && v) setVault(v) }
    })()
    return () => { on = false }
  }, [])

  const thr = vault?.threshold ?? 2
  const n = vault?.total ?? 3
  const members = vault?.member_list ?? [
    { name: 'Alice', pubkey: '317db593' },
    { name: 'Bob', pubkey: '2ca6d736' },
    { name: 'Carol', pubkey: '2fd84a5c' },
  ]

  return (
    <>
      <main className="page">
        <PageHeader
          eyebrow={t('members.eyebrow', { t: thr, n })}
          title={t('members.title')}
          subtitle={<>
            {tr('members.vmeta', { t: thr })}
            {live === false && <span className="livetag off"> {t('members.demo')}</span>}
          </>}
          actions={<Seal t={thr} n={n} />}
        />

        <div className="people mt">
          {members.map((m, i) => (
            <div className="who-row" key={i}>
              <Identicon seed={m.pubkey || m.name} size={38} />
              <div className="person-main">
                <div className="who-name">{m.name}{m.name === ME && <span className="klab"> {t('members.you')}</span>}</div>
                <div className="person-sub mono">{i === 0 ? t('members.roleCoordinator') : t('members.roleSigns')} · id {shortAddr(m.pubkey, 8, 6)}</div>
              </div>
              <span className="who-st cap">{t('members.signs')}</span>
            </div>
          ))}
        </div>

        <PageFooter>
          <span>{t('members.footCount', { count: members.length, t: thr, n })}</span>
          <span className="dim pushr">{t('members.footNote')}</span>
        </PageFooter>

        <div className="confirm mt">{tr('members.demoNote')}</div>
        <div className="right mt"><button className="btn ghost sm-btn" onClick={() => nav('/create')}>{t('members.createNew')}</button></div>
      </main>
    </>
  )
}
