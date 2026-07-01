import { useState } from 'react'
import './App.css'

type Movimento = {
  date: string
  title: string
  by?: string
  value: string
  dir: 'out' | 'in'
  status: 'verificar' | 'confirmado'
}

const MOVIMENTOS: Movimento[] = [
  { date: '28/04', title: 'Folha de abril — 8 pagamentos', by: 'prop. Ana · aprov. Ana, Bruno', value: '−4.2000', dir: 'out', status: 'verificar' },
  { date: '22/04', title: 'Doação recebida', by: 'de contribuinte anônimo', value: '+1.0000', dir: 'in', status: 'confirmado' },
  { date: '15/04', title: 'Pagamento — infraestrutura', by: 'prop. Bruno · aprov. Bruno, Carla', value: '−0.3000', dir: 'out', status: 'verificar' },
]

const ACOES: [string, string, string][] = [
  ['01', 'Novo pagamento', 'um destino'],
  ['02', 'Nova folha', 'N destinos, 1 aprovação'],
  ['03', 'Propostas', '1 aguardando'],
  ['04', 'Membros', 'modelo de confiança'],
]

/** A sensitive value hidden by the redaction bar until revealed. */
function Secret({ children, sm, onToggle }: { children: React.ReactNode; sm?: boolean; onToggle?: () => void }) {
  return (
    <span className={'secret' + (sm ? ' sm' : '')}>
      {children}
      <span className="bar" onClick={onToggle} />
    </span>
  )
}

export default function App() {
  const [revealed, setRevealed] = useState(false)
  const toggle = () => setRevealed((v) => !v)

  return (
    <div className={'sheet' + (revealed ? ' revealed' : '')}>
      <header className="lh">
        <div className="brand">
          <svg className="mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <rect x="4.5" y="4.5" width="23" height="23" stroke="#1A1813" strokeWidth="1.6" />
            <path d="M16 9.5 21.7 12.8v6.4L16 22.5l-5.7-3.3v-6.4L16 9.5Z" stroke="#7E2A24" strokeWidth="1.4" />
          </svg>
          <span className="wm">KONCLAVE</span>
        </div>
        <button className="switch">
          COFRE · <b>Tesouraria Comum</b> ▾
        </button>
      </header>

      <div className="page">
        <div className="title-row">
          <div>
            <span className="klab">Cofre coletivo · quórum</span>
            <h1 className="h1">Tesouraria Comum</h1>
            <div className="vmeta">
              Privado por fora · <b>transparente por dentro</b> · 3 membros
            </div>
          </div>
          <div className="seal-wrap">
            <div className="seal-emb">
              <svg width="90" height="90" viewBox="0 0 96 96" fill="none" aria-hidden="true">
                <circle cx="48" cy="48" r="45" stroke="#7E2A24" strokeWidth="1" />
                <circle cx="48" cy="48" r="39" stroke="#7E2A24" strokeWidth="2.4" />
                <circle cx="48" cy="48" r="34" stroke="#7E2A24" strokeWidth=".6" strokeDasharray="1 3" />
                <g stroke="#7E2A24" strokeWidth=".7" opacity=".8">
                  <circle cx="48" cy="48" r="30" />
                  <path d="M48 18c9 12 9 48 0 60M48 18c-9 12-9 48 0 60M18 48c12-9 48-9 60 0M18 48c12 9 48 9 60 0" />
                </g>
              </svg>
              <span className="num">2/3</span>
            </div>
            <div className="seal-cap">Assinaturas</div>
          </div>
        </div>

        <section className="entry">
          <div className="entry-top">
            <span className="klab">Saldo do cofre</span>
            <button className="reveal-btn" aria-pressed={revealed} onClick={toggle}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                <circle cx="12" cy="12" r="2.4" />
              </svg>
              {revealed ? 'Ocultar' : 'Revelar'}
            </button>
          </div>
          <div className="fig">
            <Secret onToggle={toggle}>
              <span className="amt">2.4180</span>
            </Secret>
            <span className="unit">ZEC</span>
          </div>
          <div className="breakdown">
            <span>
              confirmado <Secret sm><b>2.4180</b></Secret>
            </span>
            <span className="pd">
              pendente <Secret sm><b>+0.0100</b></Secret>
            </span>
          </div>
          <div className="receive">
            <span className="klab plain">Receber em</span>
            <code>u1vjgx…d406dr</code>
            <span className="orchard">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2.5 4.5 5.5v6c0 5 3.4 8.4 7.5 9.9 4.1-1.5 7.5-4.9 7.5-9.9v-6L12 2.5Z" />
              </svg>
              SÓ ENDEREÇO ORCHARD
            </span>
          </div>
        </section>

        <div className="cols">
          <section className="approve">
            <div className="req">
              <span className="stamp">Pendente</span> Requer sua aprovação
            </div>
            <div className="a-amt">
              0.5000 <span className="dim small">ZEC</span>
            </div>
            <div className="a-to">
              para <b>zs1q9f…7ka2</b> · memo “adiantamento maio”
            </div>
            <div className="a-meta">
              <span>
                proposto por <b>Bruno</b>
              </span>
              <span className="prog">
                <i className="on" />
                <i />
              </span>
              <span>1 de 2 · expira em 71h</span>
            </div>
            <div className="btns">
              <button className="btn ok">Aprovar</button>
              <button className="btn">Recusar</button>
            </div>
            <div className="note">Ao aprovar, você autoriza este pagamento com a sua parte da chave.</div>
          </section>

          <nav className="opnav">
            <span className="klab">O que fazer</span>
            {ACOES.map(([n, t, d]) => (
              <a className="op" href="#" key={n}>
                <span className="n">{n}</span>
                <span className="t">{t}</span>
                <span className="d">{d}</span>
                <span className="go">→</span>
              </a>
            ))}
          </nav>
        </div>

        <section className="ledger">
          <span className="klab">Movimentações</span>
          <div className="cap">Transparência interna — quem propôs e quem aprovou fica registrado.</div>
          {MOVIMENTOS.map((m, i) => (
            <div className="lrow" key={i}>
              <div className="ldate">{m.date}</div>
              <div className="ldesc">
                <div className="t">{m.title}</div>
                {m.by && <div className="by">{m.by}</div>}
              </div>
              <div className={'lval ' + m.dir}>
                <Secret sm>
                  <span>{m.value}</span>
                </Secret>
                <div className="st">
                  {m.status === 'verificar' ? (
                    <a className="link" href="#">
                      verificar ↗
                    </a>
                  ) : (
                    'confirmado'
                  )}
                </div>
              </div>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}
