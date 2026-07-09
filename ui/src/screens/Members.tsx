import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Letterhead, Seal } from '../components'
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
      <Letterhead right={<Link className="klab back" to="/dashboard">{t('common.backPanel')}</Link>} />
      <main className="page">
        <div className="title-row">
          <div>
            <span className="klab">{t('members.eyebrow', { t: thr, n })}</span>
            <h1 className="h1">{t('members.title')}</h1>
            <div className="vmeta">
              {tr('members.vmeta', { t: thr })}
              {live === false && <span className="livetag off"> {t('members.demo')}</span>}
            </div>
          </div>
          <Seal t={thr} n={n} />
        </div>

        <div className="people mt">
          {members.map((m, i) => (
            <div className="who-row" key={i}>
              <Identicon seed={m.pubkey || m.name} size={38} />
              <div className="person-main">
                <div className="who-name">{m.name}{m.name === ME && <span className="klab"> {t('members.you')}</span>}</div>
                <div className="person-sub mono">{i === 0 ? t('members.roleCoordinator') : t('members.roleSigns')} · id {shortAddr(m.pubkey, 8, 6)}</div>
              </div>
              <span className="who-st ok">{t('members.signs')}</span>
            </div>
          ))}
        </div>

        <div className="foot">
          <span>{t('members.footCount', { count: members.length, t: thr, n })}</span>
          <span className="dim pushr">{t('members.footNote')}</span>
        </div>

        <div className="confirm mt">{tr('members.demoNote')}</div>
        <div className="right mt"><button className="btn ghost sm-btn" onClick={() => nav('/create')}>{t('members.createNew')}</button></div>
      </main>
    </>
  )
}
