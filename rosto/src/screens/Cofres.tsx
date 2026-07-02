import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getVaults, health, setSelectedVault, unlockVault, shortAddr, type Vault } from '../api'
import { Identicon } from '../avatar'
import '../redesign.css'

/** The radial-key emblem from the logo (silver spokes + blue keyhole glow). */
function Emblem({ size = 26 }: { size?: number }) {
  const spokes = Array.from({ length: 12 }, (_, i) => i * 30)
  return (
    <svg className="rd-emblem" width={size} height={size} viewBox="0 0 40 40">
      <g stroke="#c6cfd9" strokeWidth="1.3" strokeLinecap="round" opacity="0.9">
        {spokes.map((a, i) => {
          const r = (a * Math.PI) / 180
          return <line key={i} x1={20 + Math.cos(r) * 13} y1={20 + Math.sin(r) * 13} x2={20 + Math.cos(r) * 18} y2={20 + Math.sin(r) * 18} />
        })}
      </g>
      <circle cx="20" cy="19" r="7" fill="none" stroke="#c6cfd9" strokeWidth="1.5" />
      <circle cx="20" cy="17.6" r="2.4" fill="#57a6ff" />
      <path d="M20 19.4 L18.7 25 L21.3 25 Z" fill="#57a6ff" />
    </svg>
  )
}

/** Brand: the real logo lockup (public/logo.png) if present; falls back to the
 *  SVG emblem + wordmark so the header never breaks before the asset is saved. */
function Brand() {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <span className="rd-brandwrap"><Emblem size={30} /><span className="rd-brand">Konclave</span></span>
  }
  return (
    <img
      className="rd-lockup"
      src={`${import.meta.env.BASE_URL}logo.png`}
      alt="Konclave"
      onError={() => setFailed(true)}
    />
  )
}

const MOCK: Vault[] = [
  {
    id: 'mock', name: 'Tesouraria Comum', threshold: 2, total: 3, members: 3,
    member_list: [{ name: 'Alice', pubkey: 'a' }, { name: 'Bob', pubkey: 'b' }, { name: 'Carol', pubkey: 'c' }],
    group_pubkey: '', orchard_address: 'u1vjgxlvz4ewnt43rkq6fzexpld406dr', ufvk: '',
  },
]

export default function Cofres() {
  const nav = useNavigate()
  const [vaults, setVaults] = useState<Vault[]>([])
  const [loaded, setLoaded] = useState(false)
  const [live, setLive] = useState(false)
  const [unlocking, setUnlocking] = useState<Vault | null>(null)
  const [pass, setPass] = useState('')
  const [unlockErr, setUnlockErr] = useState<string | null>(null)
  const [unlockBusy, setUnlockBusy] = useState(false)

  function enter(v: Vault) {
    setSelectedVault(v.id)
    if (v.locked) { setUnlocking(v); setPass(''); setUnlockErr(null) }
    else nav('/painel')
  }
  async function doUnlock() {
    if (!unlocking || !pass) return
    setUnlockBusy(true); setUnlockErr(null)
    const r = await unlockVault(pass)
    setUnlockBusy(false)
    if (r.ok) nav('/painel')
    else setUnlockErr(r.wrong ? 'Palavra incorreta. Tente de novo.' : 'Não foi possível verificar (cofre local offline?).')
  }

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      const vs = ok ? await getVaults() : null
      if (!on) return
      setVaults(vs && vs.length ? vs : MOCK)
      setLoaded(true)
    })()
    return () => { on = false }
  }, [])

  return (
    <div className="rd">
      <div className="rd-shell">
        <div className="rd-top">
          <Brand />
          <span className="rd-status"><span className="dot" /> <b>Ambiente seguro</b> · Local-first</span>
        </div>

        <div className="rd-hero">
          <span className="rd-eyebrow">Cofres coletivos</span>
          <h1>Seus cofres</h1>
          <p>Cada cofre é um fundo que várias pessoas cuidam <b>juntas</b> — ninguém mexe no dinheiro sozinho. Entre num cofre ou crie um novo.</p>
        </div>

        <div className="rd-grid">
          {vaults.map((v) => {
            const ms = v.member_list ?? []
            const avatars = ms.length ? ms : Array.from({ length: v.total }, (_, i) => ({ name: `Membro ${i + 1}`, pubkey: '' }))
            return (
              <div key={v.id} className="rd-card" onClick={() => enter(v)}>
                <span className="rd-qtag">Quórum {v.threshold} de {v.total}{v.locked ? ' · 🔒' : ''}</span>
                <h3>{v.name}</h3>
                <div className="rd-avatars">
                  {avatars.slice(0, 4).map((m, i) => <Identicon key={i} seed={m.pubkey || m.name} />)}
                  <span className="names">{ms.length ? ms.map((m) => m.name).join(', ') : `${v.total} membros`}</span>
                </div>
                {v.orchard_address && (
                  <div className="rd-recv"><span className="lab">receber&nbsp;</span><span className="val">{shortAddr(v.orchard_address)}</span></div>
                )}
                <button className="rd-enter">Entrar <span className="arw">→</span></button>
              </div>
            )
          })}

          <div className="rd-card rd-create" onClick={() => nav('/criar')}>
            <div>
              <div className="ic">
                <svg width="34" height="34" viewBox="0 0 34 34" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <circle cx="13.5" cy="17" r="7.5" /><circle cx="20.5" cy="17" r="7.5" />
                </svg>
              </div>
              <div className="t">Criar um novo cofre</div>
              <div className="sub">por DKG — a chave nunca existe inteira</div>
            </div>
          </div>
        </div>

        {loaded && vaults.length === 0 && (
          <div className="rd-empty">Nenhum cofre ainda. Comece criando o primeiro.</div>
        )}

        <div className="rd-note">
          🔒 Seus dados e a sua parte da chave ficam <b>só aqui, no seu aparelho</b> — não vão para nenhum servidor na internet.
          {!live && <> · <i>(modo demonstração — sem o cofre local rodando)</i></>}
        </div>
      </div>

      {unlocking && (
        <div className="unlock-overlay" onClick={() => setUnlocking(null)}>
          <div className="unlock-card" onClick={(e) => e.stopPropagation()}>
            <div className="rd-eyebrow">Cofre protegido</div>
            <h2>{unlocking.name}</h2>
            <p>Escreva a <b>palavra do cofre</b> para entrar. É a senha combinada entre os membros na criação.</p>
            <input
              className="unlock-input mono" autoFocus type="password" placeholder="palavra-do-cofre"
              value={pass} onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void doUnlock() }}
            />
            {unlockErr && <div className="unlock-err">✗ {unlockErr}</div>}
            <div className="unlock-btns">
              <button className="rd-enter" onClick={() => setUnlocking(null)}>Cancelar</button>
              <button className="rd-enter primary" onClick={() => void doUnlock()} disabled={unlockBusy || !pass}>
                {unlockBusy ? 'Verificando…' : 'Entrar →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
