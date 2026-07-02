import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead, Seal } from '../components'
import { getVault, health, shortAddr, type Vault } from '../api'

const ME = 'Alice' // this device acts as the coordinator member (single-device demo)

export default function Membros() {
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

  const t = vault?.threshold ?? 2
  const n = vault?.total ?? 3
  const members = vault?.member_list ?? [
    { name: 'Alice', pubkey: '317db593' },
    { name: 'Bob', pubkey: '2ca6d736' },
    { name: 'Carol', pubkey: '2fd84a5c' },
  ]

  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/painel')}>← Painel</span>} />
      <div className="page">
        <div className="title-row">
          <div>
            <span className="klab">Membros do cofre · quórum {t}-de-{n}</span>
            <h1 className="h1">Membros</h1>
            <div className="vmeta">
              Cada membro guarda <b>uma parte da chave</b>. São precisas <b>{t}</b> assinaturas para mover fundos.
              {live === false && <span className="livetag off"> ○ demonstração</span>}
            </div>
          </div>
          <Seal t={t} n={n} />
        </div>

        <table className="tbl razao mt">
          <thead><tr><th>Membro</th><th>Chave de comunicação</th><th>Papel</th></tr></thead>
          <tbody>
            {members.map((m, i) => (
              <tr key={i}>
                <td><b>{m.name}</b>{m.name === ME && <span className="klab"> · você</span>}</td>
                <td className="mono dim">{shortAddr(m.pubkey, 8, 6)}</td>
                <td className="by">{i === 0 ? 'coordenador + assina' : 'assina'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="foot">
          <span>{members.length} membros · quórum {t}-de-{n}</span>
          <span className="dim pushr">a chave nunca é remontada — cada parte assina no seu lugar</span>
        </div>

        <div className="confirm mt">
          Nesta demonstração as três partes rodam nesta máquina. No produto, cada membro
          aprova <b>do seu próprio dispositivo</b> com a sua parte — é o passo de multi-dispositivo do roadmap.
        </div>
        <div className="right mt"><button className="btn ghost sm-btn" onClick={() => nav('/criar')}>+ Criar um novo cofre (DKG)</button></div>
      </div>
    </>
  )
}
