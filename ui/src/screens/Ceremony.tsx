import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead, Stepper } from '../components'
import { useT, useTr } from '../i18n'
import { createVaultDkg, setSelectedVault, markVaultUnlocked, shortAddr, humanError, type Vault } from '../api'

/** Illustrative invite code for the demo. In the product each member generates
 *  their own from their own device (frost-client contact token, zffrost1…). */
function inviteCode(name: string, i: number): string {
  const seed = `${name}#${i}`
  let h = 2166136261
  for (let k = 0; k < seed.length; k++) { h ^= seed.charCodeAt(k); h = Math.imul(h, 16777619) }
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  let x = h >>> 0
  for (let k = 0; k < 34; k++) { s += abc[x % 36]; x = Math.floor(x / 36) + (k + 3) * 2654435 }
  return `zffrost1${s}`
}

export default function Ceremony() {
  const t = useT()
  const tr = useTr()
  const nav = useNavigate()
  const [step, setStep] = useState(1) // 1 Definir · 2 Convidar · 3 Criar
  const [name, setName] = useState('Tesouraria da comunidade')
  const [members, setMembers] = useState<string[]>(['Alice', 'Bob', 'Carol'])
  const [threshold, setThreshold] = useState(2)
  const [creating, setCreating] = useState(false)
  const [vault, setVault] = useState<Vault | null>(null)
  const [passphrase, setPassphrase] = useState<string | null>(null)
  const [acked, setAcked] = useState(false)
  const [wordCopied, setWordCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<number | null>(null)

  const names = members.map((m) => m.trim()).filter(Boolean)
  const n = members.length
  const updateMember = (i: number, v: string) => setMembers((p) => p.map((m, idx) => (idx === i ? v : m)))
  const addMember = () => setMembers((p) => [...p, ''])
  const removeMember = (i: number) => setMembers((p) => (p.length > 2 ? p.filter((_, idx) => idx !== i) : p))

  function goConvidar() {
    setError(null)
    if (names.length < 2) { setError(t('ceremony.errMinMembers')); return }
    if (threshold < 1 || threshold > names.length) { setError(t('ceremony.errBadQuorum')); return }
    if (threshold > n) setThreshold(n)
    setStep(2)
  }

  async function copyInvite(i: number) {
    try { await navigator.clipboard.writeText(inviteCode(names[i] ?? `m${i}`, i)); setCopied(i); setTimeout(() => setCopied(null), 1400) } catch { /* clipboard blocked */ }
  }

  async function create() {
    setError(null)
    if (names.length < 2) { setError(t('ceremony.errMinMembers')); setStep(1); return }
    setCreating(true)
    const res = await createVaultDkg(name.trim() || 'Cofre', threshold, names)
    setCreating(false)
    if (res.ok) { setSelectedVault(res.vault.id); markVaultUnlocked(res.vault.id); setVault(res.vault); setPassphrase(res.passphrase ?? null) }
    else setError(humanError(res.error, res.detail))
  }

  // --- result ---
  if (vault) {
    return (
      <>
        <Letterhead right={<span className="klab back" onClick={() => nav('/dashboard')}>{t('common.backPanel')}</span>} />
        <div className="page">
          <Stepper step={4} />
          <h1 className="h1 pine">{t('ceremony.createdTitle')}</h1>
          <div className="vmeta">{tr('ceremony.createdSubtitle')}</div>

          {passphrase && (
            <div className="word-box mt">
              <div className="word-head">{tr('ceremony.wordHead')}</div>
              <div className="word-value mono">{passphrase}</div>
              <button className="btn ghost sm-btn" onClick={() => { void navigator.clipboard.writeText(passphrase).then(() => setWordCopied(true)).catch(() => {}) }}>
                {wordCopied ? t('ceremony.wordCopied') : t('ceremony.wordCopy')}
              </button>
              <div className="word-warn">
                {tr('ceremony.wordWarn')}
                <div className="hint mt-xs">{tr('ceremony.wordWarnHint')}</div>
              </div>
              <label className="word-ack">
                <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} /> {t('ceremony.wordAck')}
              </label>
            </div>
          )}

          <span className="klab mt">{t('ceremony.vault')}</span>
          <div className="mono">{tr('ceremony.vaultQuorum', { name: vault.name, t: vault.threshold, n: vault.total })}</div>

          <span className="klab mt">{t('ceremony.receiveAddress')}</span>
          <div className="row-gap"><input className="input mono" value={vault.orchard_address} readOnly /></div>
          <div className="hint warn">{t('ceremony.orchardOnlyWarn')}</div>

          <span className="klab mt">{t('ceremony.groupKey')}</span>
          <div className="mono dim">{shortAddr(vault.group_pubkey, 10, 8)}</div>

          <span className="klab mt">{t('ceremony.members')}</span>
          <table className="tbl razao">
            <tbody>
              {vault.member_list.map((m, i) => (
                <tr key={i}><td><b>{m.name}</b></td><td className="mono dim">{shortAddr(m.pubkey, 8, 6)}</td></tr>
              ))}
            </tbody>
          </table>

          <hr className="rule" />
          <div className="right">
            <button className="btn ok" onClick={() => nav('/dashboard')} disabled={!!passphrase && !acked}
              title={!!passphrase && !acked ? t('ceremony.confirmSavedWord') : ''}>{t('ceremony.goToVault')}</button>
          </div>
        </div>
      </>
    )
  }

  // --- creating ---
  if (creating) {
    return (
      <>
        <Letterhead right={<span className="klab">{t('ceremony.creating')}</span>} />
        <div className="page">
          <Stepper step={3} />
          <h1 className="h1">{t('ceremony.generatingTitle')}</h1>
          <div className="vmeta">{t('ceremony.generatingSubtitle')}</div>
          <div className="progress-bar"><span /></div>
        </div>
      </>
    )
  }

  // --- form: step 1 Definir · step 2 Convidar ---
  return (
    <>
      <Letterhead right={<span className="klab back" onClick={() => nav('/')}>{t('common.backVaults')}</span>} />
      <div className="page narrow">
        <Stepper step={step} />

        {step === 1 && (
          <>
            <h1 className="h1">{t('ceremony.createVault')}</h1>
            <p className="cap">{tr('ceremony.step1Cap')}</p>

            <label className="field"><span>{t('ceremony.vaultName')}</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            <span className="klab">{t('ceremony.whoCares')}</span>
            {members.map((m, i) => (
              <div key={i} className="row-gap mt-xs">
                <input className="input" value={m} onChange={(e) => updateMember(i, e.target.value)} placeholder={t('ceremony.personNamePlaceholder')} />
                <button className="row-del" title={t('common.remove')} onClick={() => removeMember(i)} disabled={members.length <= 2}>×</button>
              </div>
            ))}
            <div className="mt-sm"><button className="btn ghost sm-btn" onClick={addMember}>{t('ceremony.addPerson')}</button></div>

            <div className="field mt"><span>{t('ceremony.howManyApprovals')}</span>
              <div className="selq">
                <select className="box" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
                  {Array.from({ length: Math.max(n, 1) }, (_, i) => i + 1).map((q) => <option key={q} value={q}>{q}</option>)}
                </select>
                <span className="selq-unit"> {t('ceremony.ofNPeople', { n })}</span>
              </div>
              <div className="hint">{t('ceremony.quorumHint', { threshold, approvals: threshold === 1 ? t('ceremony.approvalSingular') : t('ceremony.approvalPlural') })}</div>
            </div>

            {error && <div className="hint err mt">✗ {error}</div>}
            <hr className="rule" />
            <div className="right"><button className="btn ok" onClick={goConvidar}>{t('ceremony.invitePeople')}</button></div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="h1">{t('ceremony.inviteTitle')}</h1>
            <p className="cap">{tr('ceremony.step2Cap')}</p>

            <div className="invite-list">
              {names.map((nm, i) => (
                <div className="invite" key={i}>
                  <div className="invite-top">
                    <span className="invite-name">{nm}</span>
                    <span className="invite-tag">{i === 0 ? t('ceremony.inviteHost') : t('ceremony.inviteGuest')}</span>
                  </div>
                  <div className="invite-code">
                    <code>{shortAddr(inviteCode(nm, i), 14, 8)}</code>
                    <button className="btn ghost sm-btn" onClick={() => copyInvite(i)}>{copied === i ? t('ceremony.inviteCopied') : t('ceremony.inviteCopy')}</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="confirm mt">{tr('ceremony.demoNote')}</div>

            {error && <div className="hint err mt">✗ {error}</div>}
            <hr className="rule" />
            <div className="row-gap center-between">
              <button className="btn ghost" onClick={() => setStep(1)}>{t('common.back')}</button>
              <button className="btn ok" onClick={create}>{t('ceremony.createNowDkg')}</button>
            </div>
          </>
        )}
      </div>
    </>
  )
}
