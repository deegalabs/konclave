import { Link } from 'react-router-dom'
import { Letterhead, Seal, Secret, RevealButton } from '../components'

type Movimento = { date: string; title: string; by?: string; value: string; dir: 'out' | 'in'; status: string }

const MOVIMENTOS: Movimento[] = [
  { date: '28/04', title: 'Folha de abril — 8 pagamentos', by: 'prop. Ana · aprov. Ana, Bruno', value: '−4.2000', dir: 'out', status: 'verificar' },
  { date: '22/04', title: 'Doação recebida', by: 'de contribuinte anônimo', value: '+1.0000', dir: 'in', status: 'confirmado' },
  { date: '15/04', title: 'Pagamento — infraestrutura', by: 'prop. Bruno · aprov. Bruno, Carla', value: '−0.3000', dir: 'out', status: 'verificar' },
]

const ACOES: [string, string, string, string][] = [
  ['01', 'Novo pagamento', 'um destino', '/pagar'],
  ['02', 'Nova folha', 'N destinos, 1 aprovação', '/folha'],
  ['03', 'Propostas', '1 aguardando', '/proposta'],
  ['04', 'Razão / contas', 'entregar ao contador', '/razao'],
]

export default function Painel() {
  return (
    <>
      <Letterhead right={<button className="switch">COFRE · <b>Tesouraria Comum</b> ▾</button>} />
      <div className="page">
        <div className="title-row">
          <div>
            <span className="klab">Cofre coletivo · quórum</span>
            <h1 className="h1">Tesouraria Comum</h1>
            <div className="vmeta">Privado por fora · <b>transparente por dentro</b> · 3 membros</div>
          </div>
          <Seal t={2} n={3} />
        </div>

        <section className="entry">
          <div className="entry-top">
            <span className="klab">Saldo do cofre</span>
            <RevealButton />
          </div>
          <div className="fig">
            <Secret><span className="amt">2.4180</span></Secret>
            <span className="unit">ZEC</span>
          </div>
          <div className="breakdown">
            <span>confirmado <Secret sm><b>2.4180</b></Secret></span>
            <span className="pd">pendente <Secret sm><b>+0.0100</b></Secret></span>
          </div>
          <div className="receive">
            <span className="klab plain">Receber em</span>
            <code>u1vjgx…d406dr</code>
            <span className="orchard">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2.5 4.5 5.5v6c0 5 3.4 8.4 7.5 9.9 4.1-1.5 7.5-4.9 7.5-9.9v-6L12 2.5Z" /></svg>
              SÓ ENDEREÇO ORCHARD
            </span>
          </div>
        </section>

        <div className="cols">
          <section className="approve">
            <div className="req"><span className="stamp">Pendente</span> Requer sua aprovação</div>
            <div className="a-amt">0.5000 <span className="dim small">ZEC</span></div>
            <div className="a-to">para <b>zs1q9f…7ka2</b> · memo “adiantamento maio”</div>
            <div className="a-meta">
              <span>proposto por <b>Bruno</b></span>
              <span className="prog"><i className="on" /><i /></span>
              <span>1 de 2 · expira em 71h</span>
            </div>
            <div className="btns">
              <Link className="btn ok" to="/proposta">Aprovar</Link>
              <button className="btn">Recusar</button>
            </div>
            <div className="note">Ao aprovar, você autoriza este pagamento com a sua parte da chave.</div>
          </section>

          <nav className="opnav">
            <span className="klab">O que fazer</span>
            {ACOES.map(([n, t, d, to]) => (
              <Link className="op" to={to} key={n}>
                <span className="n">{n}</span>
                <span className="t">{t}</span>
                <span className="d">{d}</span>
                <span className="go">→</span>
              </Link>
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
                <Secret sm><span>{m.value}</span></Secret>
                <div className="st">{m.status === 'verificar' ? <Link className="link" to="/razao">verificar ↗</Link> : 'confirmado'}</div>
              </div>
            </div>
          ))}
        </section>
      </div>
    </>
  )
}
