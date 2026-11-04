import { ensureWasm } from '../wasm-ready'
// /lab/background-signer - watch background signing (issue #49, Stage 3) run, on a vault that exists
// only in this page: a 2-of-3 made by a real DKG between three simulated devices, talking over an
// in-memory bus. It never lists, unlocks or joins a vault a member owns, never opens the relay and
// never calls the coordinator (lab-vault.ts says why, lab-isolation.test.ts holds it). The signed
// message is the demo vector's sighash, never a broadcast.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Letterhead } from '../components'
import { useT } from '../i18n'
import { LabVault, type LabDevice } from '../lab-vault'
import { makeSigningGate, type SigningMode } from '../signing-gate'
import { fmtZecExact, shortAddr } from '../format'

export default function BackgroundSignerLab() {
  const t = useT()
  const [devices, setDevices] = useState<LabDevice[]>([])
  const [groupKey, setGroupKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  // Governance policy, demonstrated: an approved payment signs on its own in `auto`, and waits to be
  // armed in `manual`. Read live by every device, through refs, so a change takes effect at once.
  const [mode, setMode] = useState<SigningMode>('manual')
  const [armed, setArmed] = useState(false)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const armedRef = useRef(armed)
  armedRef.current = armed
  const [lab, setLab] = useState<LabVault | null>(null)
  // The current vault, for its callbacks: one from a vault replaced by "New lab vault" is ignored.
  const labRef = useRef<LabVault | null>(null)

  async function create() {
    setBusy(true)
    setMsg('')
    try {
      await ensureWasm()
      const gate = makeSigningGate({ mode: () => modeRef.current, isApproved: () => true, isArmed: () => armedRef.current })
      const lab = new LabVault({ gate, onChange: () => { if (labRef.current === lab) setDevices(lab.view()) } })
      labRef.current = lab
      setLab(lab)
      setDevices(lab.view())
      setArmed(false)
      setGroupKey(lab.groupKeyHex)
      await lab.seat()
    } catch (e) {
      setMsg('Could not create the lab vault: ' + String(e))
    } finally {
      setBusy(false)
    }
  }

  async function step(f: (lab: LabVault) => Promise<void>) {
    if (!lab) return
    setBusy(true)
    try {
      await f(lab)
    } catch (e) {
      setMsg(String(e))
    } finally {
      setBusy(false)
    }
  }

  // The vault dies with the page.
  useEffect(() => () => { labRef.current = null }, [])

  const approved = devices.filter((d) => d.approved).length
  // What the devices read the request to pay (each reads it on its own; they read the same bytes).
  const what = devices.find((d) => d.what)?.what ?? null

  return (
    <>
      <Letterhead right={<Link className="klab back" to="/lab">← Lab</Link>} />
      <main className="page" style={{ maxWidth: 640, margin: '0 auto' }}>
        <h1 className="klab" style={{ fontSize: 24, marginTop: 12 }}>Background signing (Stage 3)</h1>
        <p className="dim" style={{ marginTop: 6 }}>
          Three simulated devices hold a 2-of-3 vault that exists only in this page: made here by a real
          key generation, signing over an in-memory channel. No vault of yours is listed, unlocked or
          touched, and nothing leaves this page. The payment is a test transaction, never broadcast.
        </p>
        <p className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
          To use your own vaults, go to <Link to="/vaults">your vaults</Link>.
        </p>

        {!lab && (
          <div className="confirm mt">
            <button className="btn ok sm-btn" disabled={busy} onClick={() => void create()}>
              {busy ? 'Creating…' : 'Create a lab vault (2 of 3)'}
            </button>
            {msg && <p className="dim" style={{ color: 'var(--danger-text)' }}>{msg}</p>}
          </div>
        )}

        {lab && (
          <div className="fp-card mt">
            <div className="fp-head">
              <span className="klab">Lab vault</span>
              <span className="mono dim">{shortAddr(groupKey, 8, 6)}</span>
            </div>

            {devices.map((d) => (
              <div key={d.seat} className="db-meta" style={{ display: 'flex', gap: 20, marginTop: 8, flexWrap: 'wrap' }}>
                <div><span className="klab">Device</span><br /><b>{d.seat}</b></div>
                <div><span className="klab">Seats seen</span><br /><b>{d.seats}</b></div>
                <div><span className="klab">Approved</span><br /><b>{d.approved ? 'yes' : 'no'}</b></div>
                <div><span className="klab">State</span><br /><b>{d.phase}</b></div>
                {d.signature && (
                  <div style={{ color: d.signature.ok ? 'var(--success)' : 'var(--danger-text)' }}>
                    <span className="klab">Signature</span><br />
                    {d.signature.ok ? '✓ verifies' : '✗ did not verify'} <span className="mono">{shortAddr(d.signature.hex, 10, 8)}</span>
                  </div>
                )}
                {d.error && <p className="dim" style={{ color: 'var(--danger-text)', flexBasis: '100%', margin: 0 }}>{t(d.error)}</p>}
              </div>
            ))}

            {what && (
              <p className="dim mt-sm">
                signing: {what.outputs.map((o) => `${fmtZecExact(o.zat / 1e8)} ZEC → ${o.addr ? shortAddr(o.addr, 10, 6) : 'no label'}`).join(', ')} · fee {fmtZecExact(what.feeZat / 1e8)} ZEC
              </p>
            )}

            <div className="mt-sm" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <span className="klab">Signing mode</span>
              {(['auto', 'manual'] as SigningMode[]).map((m) => (
                <label key={m} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  <input type="radio" name="mode" checked={mode === m} onChange={() => { setMode(m); setArmed(false) }} />
                  <span className="mono">{m}</span>
                </label>
              ))}
            </div>
            <p className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>
              {mode === 'auto'
                ? 'auto: an approved payment signs on its own.'
                : 'manual: an approved payment waits until you arm it (a single click never fires money).'}
            </p>

            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn ghost sm-btn" disabled={busy || approved >= 2} onClick={() => void step((l) => l.approve([1, 2]))}>
                Devices 1 and 2 approve
              </button>
              <button className="btn ghost sm-btn" disabled={busy || approved < 2} onClick={() => { setArmed(false); void step((l) => l.request()) }}>
                Send the test sign-request
              </button>
              {mode === 'manual' && (
                <button className="btn ok sm-btn" disabled={busy || approved < 2 || armed} onClick={() => { setArmed(true); armedRef.current = true; void step((l) => l.retry()) }}>
                  Approve &amp; sign
                </button>
              )}
              <button className="btn ghost sm-btn" disabled={busy} onClick={() => void create()}>
                New lab vault
              </button>
            </div>
            <p className="dim" style={{ fontSize: 12.5, marginTop: 8 }}>
              Device 3 stays seated and never signs: its owner did not approve. The test transaction is
              a NU6.3 one, so once the network has moved past NU6.3 every device refuses it, correctly,
              and this page shows that refusal.
            </p>
            {msg && <p className="dim" style={{ color: 'var(--danger-text)' }}>{msg}</p>}
          </div>
        )}
      </main>
    </>
  )
}
