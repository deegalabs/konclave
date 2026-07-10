import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useT, useTr } from '../i18n'
import '../redesign.css'
import '../demo.css'

const CAST: Array<[string, string]> = [
  ['A', '#57a6ff'], ['B', '#5ed39a'], ['C', '#e3ad52'], ['D', '#c58bf0'], ['E', '#e77f74'],
]

/** Guided demo — the "coletivo Horizonte" scenario as a 7-step player. */
export default function Demo() {
  const t = useT()
  const tr = useTr()
  const [cur, setCur] = useState(0)
  const N = 7
  const go = (i: number) => { setCur(Math.max(0, Math.min(N - 1, i))); window.scrollTo(0, 0) }

  const meta = (n: number) => ({
    name: t(`demo.s${n}Name`), eyebrow: t(`demo.s${n}Eyebrow`), title: t(`demo.s${n}Title`),
    narr: `demo.s${n}Narr`, why: `demo.s${n}Why`,
  })
  const m = meta(cur + 1)

  function mock(i: number): ReactNode {
    switch (i) {
      case 0: return (
        <div className="dm-mock" data-scr={t('demo.scrCast')}>
          <div className="dm-cast">
            {CAST.map(([ini, col], j) => (
              <span className="dm-person" key={j}><span className="dm-ava" style={{ background: col }}>{ini}</span>
                <span className="pn">{['Ana', 'Bruno', 'Carla', 'Davi', 'Elis'][j]}</span></span>
            ))}
          </div>
          <div className="dm-fund">
            <span className="fi"><svg viewBox="0 0 24 24" width="19" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /></svg></span>
            <div><b>{t('demo.s1Fund')}</b><div className="fs">{t('demo.s1FundSub')}</div></div>
          </div>
        </div>
      )
      case 1: return (
        <div className="dm-mock" data-scr={t('demo.scrCreate')}>
          <div className="dm-row"><span className="rk">{t('demo.lblMembers')}</span><span className="rv">Ana · Bruno · Carla · Davi · Elis</span></div>
          <div className="dm-row"><span className="rk">{t('demo.lblQuorum')}</span><span className="rv">3 <span style={{ color: 'var(--text-muted)' }}>{t('demo.quorumMid')}</span> 5</span></div>
          <div className="dm-row"><span className="rk">{t('demo.lblAddress')}</span><span className="dm-addr">u1horizonte…9x2f</span></div>
        </div>
      )
      case 2: return (
        <div className="dm-mock" data-scr={t('demo.scrBalance')}>
          <div className="dm-klab">{t('demo.lblBalance')}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 8 }}>
            <span className="dm-big">0.9000</span><span className="dm-unit">ZEC</span>
            <span className="dm-chip ok" style={{ marginLeft: 'auto' }}><i />{t('demo.received')}</span>
          </div>
          <div className="dm-row" style={{ marginTop: 14 }}><span className="rk">{t('demo.receivedAt')}</span><span className="dm-addr">u1horizonte…9x2f</span></div>
        </div>
      )
      case 3: return (
        <div className="dm-mock" data-scr={t('demo.scrPayroll')}>
          {['Ivo M.', 'Lia S.', 'Ravi O.'].map((who) => (
            <div className="dm-row" key={who}><span className="rk">{who}</span><span className="rv dm-hide">0.1000</span></div>
          ))}
          <div className="dm-row"><span className="rk" style={{ color: 'var(--text)', fontWeight: 600 }}>{t('demo.payrollTotal')}</span><span className="rv dm-hide">0.3000</span></div>
        </div>
      )
      case 4: return (
        <div className="dm-mock" data-scr={t('demo.scrProposal')}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
            <span className="dm-chip ok"><i />{t('demo.readyToSign')}</span>
            <span className="dm-pips"><b>3/3</b><span className="dm-pip full" /><span className="dm-pip full" /><span className="dm-pip full" /></span>
          </div>
          <div className="dm-votes">
            {[['A', '#57a6ff', 'Ana', 'yes'], ['B', '#5ed39a', 'Bruno', 'yes'], ['C', '#e3ad52', 'Carla', 'yes'], ['D', '#c58bf0', 'Davi', 'pending']].map(([ini, col, nm, st], j) => (
              <div className="dm-vote" key={j}><span className="dm-ava" style={{ background: col as string, width: 24, height: 24 }}>{ini}</span>{nm}
                <span className={'vs ' + st}>{st === 'yes' ? t('demo.approved') : t('demo.notNeeded')}</span></div>
            ))}
          </div>
        </div>
      )
      case 5: return (
        <div className="dm-mock" data-scr={t('demo.scrSent')}>
          <div className="dm-sent">
            <svg viewBox="0 0 96 96" fill="none"><circle cx="48" cy="48" r="45" stroke="#37424e" /><circle cx="48" cy="48" r="34" stroke="#5ed39a" strokeOpacity=".35" strokeDasharray="2 4" /><circle cx="48" cy="48" r="26" fill="rgba(94,211,154,.10)" stroke="#5ed39a" strokeOpacity=".5" /><path d="M37 48l7.5 7.5L60 40" stroke="#5ed39a" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <h3>{t('demo.sentTitle')}</h3>
            <div className="dm-txid">{t('demo.sentMeta')}</div>
          </div>
        </div>
      )
      default: return (
        <div className="dm-mock" data-scr={t('demo.scrLedger')}>
          <table className="dm-led">
            <thead><tr><th>{t('demo.colDate')}</th><th>{t('demo.colDoc')}</th><th>{t('demo.colWho')}</th><th style={{ textAlign: 'right' }}>{t('demo.colValue')}</th></tr></thead>
            <tbody>
              {['Ivo M.', 'Lia S.', 'Ravi O.'].map((who, j) => (
                <tr key={who}><td className="mono" style={{ color: 'var(--text-muted)' }}>{j === 0 ? '30 jun' : ''}</td>
                  <td><span className="tg">{t('demo.tagFolha')}</span></td><td>{who}</td><td className="n">−0.1000</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
  }

  return (
    <div className="rd dm">
      <div className="dm-shell">
        <header className="dm-top">
          <Link to="/intro" className="dm-brand">
            <svg width="26" height="26" viewBox="0 0 44 44" fill="none" aria-hidden="true"><circle cx="22" cy="22" r="20.5" stroke="var(--line-strong)" /><circle cx="22" cy="22" r="15" stroke="var(--accent)" strokeOpacity=".55" /><circle cx="22" cy="22" r="6.4" fill="var(--accent)" fillOpacity=".14" stroke="var(--accent)" /><circle cx="22" cy="22" r="2" fill="var(--accent)" /></svg>
            <span className="wm">KONCLAVE</span>
          </Link>
          <span className="dm-tag">{tr('demo.tag')}</span>
        </header>

        <div className="dm-prog">
          {Array.from({ length: N }, (_, i) => <div key={i} className={'pd' + (i < cur ? ' done' : i === cur ? ' cur' : '')} />)}
        </div>
        <div className="dm-meta">
          <span>{t('demo.stepOf', { n: cur + 1, total: N })}</span>
          <span>{m.name}</span>
        </div>

        <div className="dm-stage">
          <div className="dm-step" key={cur}>
            <span className="dm-eyebrow">{m.eyebrow}</span>
            <h2>{m.title}</h2>
            <p className="dm-narr">{tr(m.narr)}</p>
            {mock(cur)}
            <div className="dm-why"><span className="wl">{t('demo.whyLabel')}</span>{tr(m.why)}</div>
          </div>
        </div>

        <div className="dm-nav">
          <button className="btn" onClick={() => go(cur - 1)} disabled={cur === 0}>← {t('demo.prev')}</button>
          <div className="dm-dots">
            {Array.from({ length: N }, (_, i) => (
              <button key={i} className={'dm-dot' + (i === cur ? ' cur' : '')} aria-label={`${i + 1}`} onClick={() => go(i)} />
            ))}
          </div>
          {cur === N - 1
            ? <button className="btn ok" onClick={() => go(0)}>{t('demo.restart')}</button>
            : <button className="btn ok" onClick={() => go(cur + 1)}>{t('demo.next')} →</button>}
        </div>
      </div>
    </div>
  )
}
