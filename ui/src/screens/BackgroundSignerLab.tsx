import { ensureWasm } from '../wasm-ready'
// /lab/background-signer - watch background signing (issue #49, Stage 3) run, on a vault that exists
// only in this page: a 2-of-3 made by a real DKG between three simulated devices, talking over an
// in-memory bus. It never lists, unlocks or joins a vault a member owns, never opens the relay and
// never calls the coordinator (lab-vault.ts says what the devices run and what they skip;
// lab-isolation.test.ts holds the page to it). The signed message is a test transaction's sighash,
// never a broadcast.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Letterhead } from '../components'
import { useT } from '../i18n'
import { LabVault, type LabDevice } from '../lab-vault'
import { fmtZecExact, shortAddr } from '../format'

/** The refusals a device gives a transaction whose network version or validity window it does not
 *  accept. In the lab, past the upgrade, that is the test transaction's age and not the device. */
const UPGRADE_REFUSALS = new Set(['net.err.network', 'net.err.expiry'])

export default function BackgroundSignerLab() {
  const t = useT()
  const [lab, setLab] = useState<LabVault | null>(null)
  const [devices, setDevices] = useState<LabDevice[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  // The current vault, for its callbacks: one from a vault replaced by "New lab vault" is ignored.
  const labRef = useRef<LabVault | null>(null)

  async function create() {
    setBusy(true)
    setMsg('')
    try {
      await ensureWasm()
      const next: LabVault = new LabVault({ onChange: () => { if (labRef.current === next) setDevices(next.view()) } })
      labRef.current = next
      setLab(next)
      setDevices(next.view())
      await next.seat()
    } catch (e) {
      setMsg('Could not create the lab vault: ' + String(e))
    } finally {
      setBusy(false)
    }
  }

  async function step(f: (l: LabVault) => Promise<void>) {
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
  const refusal = (key: string) =>
    UPGRADE_REFUSALS.has(key) && lab?.vectorPredatesUpgrade()
      ? 'Refused, correctly: the lab\'s test transaction was built for the network version before the latest upgrade, which this device knows has activated. Nothing is wrong with this device; the lab needs a newer test transaction.'
      : t(key)

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
              <span className="mono dim">{shortAddr(lab.groupKeyHex, 8, 6)}</span>
            </div>

            {devices.map((d) => (
              <div key={d.seat} className="db-meta" style={{ display: 'flex', gap: 20, marginTop: 8, flexWrap: 'wrap' }}>
                <div><span className="klab">Device</span><br /><b>{d.seat}</b></div>
                <div><span className="klab">Seats seen</span><br /><b>{d.seats}</b></div>
                <div><span className="klab">Signed by owner</span><br /><b>{d.approved ? 'yes' : 'no'}</b></div>
                <div><span className="klab">State</span><br /><b>{d.phase}</b></div>
                {d.signature && (
                  <div style={{ color: d.signature.ok ? 'var(--success)' : 'var(--danger-text)' }}>
                    <span className="klab">Signature</span><br />
                    {d.signature.ok ? '✓ verifies' : '✗ did not verify'} <span className="mono">{shortAddr(d.signature.hex, 10, 8)}</span>
                  </div>
                )}
                {d.error && <p className="dim" style={{ color: 'var(--danger-text)', flexBasis: '100%', margin: 0 }}>{refusal(d.error)}</p>}
              </div>
            ))}

            {what && (
              <p className="dim mt-sm">
                signing: {what.outputs.map((o) => `${fmtZecExact(o.zat / 1e8)} ZEC → ${o.addr ? shortAddr(o.addr, 10, 6) : 'no label'}`).join(', ')} · fee {fmtZecExact(what.feeZat / 1e8)} ZEC
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn ok sm-btn" disabled={busy || approved >= 2} onClick={() => void step((l) => l.approve([1, 2]))}>
                Owners of devices 1 and 2 sign
              </button>
              <button className="btn ghost sm-btn" disabled={busy || approved < 2} onClick={() => void step((l) => l.request())}>
                Send the test sign-request
              </button>
              <button className="btn ghost sm-btn" disabled={busy} onClick={() => void create()}>
                New lab vault
              </button>
            </div>
            <p className="dim" style={{ fontSize: 12.5, marginTop: 8 }}>
              As in the app, a device puts its share in only for an owner who signed, within ten minutes,
              and only for the one transaction it then cleared. Device 3 stays seated and never signs: its
              owner did not sign.
            </p>
            {msg && <p className="dim" style={{ color: 'var(--danger-text)' }}>{msg}</p>}
          </div>
        )}
      </main>
    </>
  )
}
