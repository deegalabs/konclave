import { Fragment, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead, Secret, RevealButton } from '../components'
import { getLedger, getProposalDetail, getVault, ledgerCsvUrl, health, shortAddr, type Proposal, type PayrollLine } from '../api'
import { fmtDate } from '../format'

const STATE_LABEL: Record<string, string> = {
  awaiting: 'aguardando', ready: 'pronta', sent: 'enviada',
  confirmed: 'confirmada', rejected: 'recusada', expired: 'expirada', cancelled: 'cancelada',
}
const SETTLED = (s: string) => s === 'sent' || s === 'confirmed'


export default function Razao() {
  const nav = useNavigate()
  const [rows, setRows] = useState<Proposal[] | null>(null)
  const [live, setLive] = useState(false)
  const [vaultName, setVaultName] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [linesById, setLinesById] = useState<Record<string, PayrollLine[]>>({})
  const [fState, setFState] = useState<'all' | 'settled' | 'openp'>('all')
  const [fKind, setFKind] = useState<'all' | 'payment' | 'payroll'>('all')

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      const [l, v] = await Promise.all([getLedger(), getVault()])
      if (!on) return
      if (l) setRows(l)
      if (v) setVaultName(v.name)
    })()
    return () => { on = false }
  }, [])

  async function toggle(p: Proposal) {
    if (p.kind !== 'payroll') return
    const next = new Set(open)
    if (next.has(p.id)) { next.delete(p.id); setOpen(next); return }
    next.add(p.id); setOpen(next)
    if (!linesById[p.id]) {
      const detail = await getProposalDetail(p.id)
      if (detail?.lines) setLinesById((m) => ({ ...m, [p.id]: detail.lines }))
    }
  }

  const ledger = rows ?? []
  const settled = ledger.filter((p) => SETTLED(p.state))
  const pending = ledger.filter((p) => p.state === 'awaiting' || p.state === 'ready')
  const totalOut = settled.reduce((acc, p) => acc + Number(p.value_zec), 0)
  const totalPending = pending.reduce((acc, p) => acc + Number(p.value_zec), 0)
  // Period from the entries' real creation dates.
  const dates = ledger.map((p) => p.created_at).filter(Boolean) as number[]
  const period = dates.length
    ? `${fmtDate(Math.min(...dates))} – ${fmtDate(Math.max(...dates))}`
    : '—'
  const filtered = ledger.filter((p) => {
    const stOk = fState === 'all' || (fState === 'settled' ? SETTLED(p.state) : p.state === 'awaiting' || p.state === 'ready')
    const knOk = fKind === 'all' || p.kind === fKind
    return stOk && knOk
  })

  return (
    <>
      <Letterhead
        right={
          <span className="lh-actions">
            <span className="klab back" onClick={() => nav('/painel')}>← Painel</span>
            <a className="btn ghost sm-btn" href={ledgerCsvUrl()} download="konclave-razao.csv">⭳ Exportar CSV</a>
            <button className="btn ghost sm-btn" onClick={() => window.print()}>⭳ PDF</button>
          </span>
        }
      />
      <div className="page">
        <h1 className="h1">Razão</h1>

        {/* Banda de documento — o livro do cofre para entregar ao contador */}
        <div className="doc-band">
          <div className="db-meta">
            <div><span className="klab">Cofre</span><b>{vaultName ?? 'Tesouraria Comum'}</b></div>
            <div><span className="klab">Período</span><b className="mono">{period}</b></div>
            <div><span className="klab">Lançamentos</span><b>{ledger.length}</b></div>
          </div>
          <div className="db-totals">
            <div className="db-t"><span className="klab">Saída liquidada</span><Secret sm><b className="out">−{totalOut.toFixed(4)}</b></Secret></div>
            <div className="db-t"><span className="klab">Em aberto</span><Secret sm><b className="dim">{totalPending.toFixed(4)}</b></Secret></div>
            <span className="db-reveal"><RevealButton /></span>
          </div>
        </div>
        <div className="cap">{live ? 'Registro ao vivo — quem propôs e aprovou fica registrado. A folha abre em cada beneficiário.' : 'Modo demonstração.'}</div>

        <div className="filters">
          <span className="chip-group">
            <button className={'chip' + (fState === 'all' ? ' on' : '')} onClick={() => setFState('all')}>Todos</button>
            <button className={'chip' + (fState === 'settled' ? ' on' : '')} onClick={() => setFState('settled')}>Liquidados</button>
            <button className={'chip' + (fState === 'openp' ? ' on' : '')} onClick={() => setFState('openp')}>Em aberto</button>
          </span>
          <span className="chip-group">
            <button className={'chip' + (fKind === 'all' ? ' on' : '')} onClick={() => setFKind('all')}>Tudo</button>
            <button className={'chip' + (fKind === 'payment' ? ' on' : '')} onClick={() => setFKind('payment')}>Pagamentos</button>
            <button className={'chip' + (fKind === 'payroll' ? ' on' : '')} onClick={() => setFKind('payroll')}>Folhas</button>
          </span>
          {filtered.length !== ledger.length && <span className="chip-note">mostrando {filtered.length} de {ledger.length}</span>}
        </div>

        <table className="tbl razao mt">
          <thead><tr><th>Data</th><th>Documento</th><th>Quem propôs / aprovou</th><th>Valor</th></tr></thead>
          <tbody>
            {ledger.length === 0 && (
              <tr><td colSpan={4} className="by">Nenhum lançamento ainda. Propostas aparecem aqui conforme são criadas.</td></tr>
            )}
            {ledger.length > 0 && filtered.length === 0 && (
              <tr><td colSpan={4} className="by">Nenhum lançamento neste filtro.</td></tr>
            )}
            {filtered.map((p) => {
              const isPayroll = p.kind === 'payroll'
              const who = `prop. ${p.proposer}${p.approvals.length ? ` / aprov. ${p.approvals.join(', ')}` : ''}`
              const settledRow = SETTLED(p.state)
              const isOpen = open.has(p.id)
              const lines = linesById[p.id]
              return (
                <Fragment key={p.id}>
                  <tr className={isPayroll ? 'doc-row' : ''} onClick={() => toggle(p)} style={isPayroll ? { cursor: 'pointer' } : undefined}>
                    <td className="mono">{fmtDate(p.created_at)}</td>
                    <td>
                      {isPayroll && <span className="caret">{isOpen ? '▾' : '▸'} </span>}
                      {p.memo || (isPayroll ? 'Folha de pagamento' : 'Pagamento')}
                      <div className="by">
                        {isPayroll ? 'folha' : 'pagamento'}
                        {isPayroll ? ' · abre em cada beneficiário' : (p.to_address ? ` · para ${shortAddr(p.to_address)}` : '')}
                      </div>
                    </td>
                    <td className="by">{who}</td>
                    <td className="num out">
                      <Secret sm><span>−{Number(p.value_zec).toFixed(4)}</span></Secret>
                      <div className="by">
                        {settledRow && p.txid
                          ? <a className="link" href={`https://mainnet.zcashexplorer.app/transactions/${p.txid}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{STATE_LABEL[p.state]} ↗</a>
                          : (STATE_LABEL[p.state] ?? p.state)}
                      </div>
                    </td>
                  </tr>
                  {isPayroll && isOpen && (lines
                    ? lines.map((l, i) => (
                      <tr key={`${p.id}-${i}`} className="li-sub">
                        <td></td>
                        <td className="mono dim">↳ {l.label || shortAddr(l.address)}<div className="by">{shortAddr(l.address)}{l.is_public ? ' · ⚠ público' : ''}{l.memo ? ` · ${l.memo}` : ''}</div></td>
                        <td></td>
                        <td className="num"><Secret sm><span>−{Number(l.value_zec).toFixed(4)}</span></Secret></td>
                      </tr>
                    ))
                    : <tr className="li-sub"><td></td><td className="by" colSpan={3}>carregando beneficiários…</td></tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>

        <div className="foot">
          <span className="dim pushr">transparência interna · a blockchain pública nada revela</span>
        </div>
      </div>
    </>
  )
}
