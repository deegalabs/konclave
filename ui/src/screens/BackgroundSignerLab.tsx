// /lab/background-signer — a laboratory surface to watch Stage 3 (issue #49) run live: unlock a
// saved vault, and its share signs a payment IN THE BACKGROUND (no /net screen). Two browser tabs
// on the same saved vault seat each other over the vault's signing room, and an injected test
// sign-request (standing in for the helper) is signed by both. Isolated from the product, like the
// rest of /lab. The signed message here is a TEST digest (the demo vector), never a broadcast.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Letterhead } from '../components'
import init, { pcztSighash } from '../wasm-pkg/konclave_wasm.js'
import wasmUrl from '../wasm-pkg/konclave_wasm_bg.wasm?url'
import { listVaults, loadVault, type VaultPublic } from '../storage'
import { setUnlockedShare, getUnlockedShare } from '../session'
import { parseAlphas } from '../signing'
import { bytesToHex } from '../net-sign'
import { dkgProvenPczt } from '../demo-vector'
import { useBackgroundSigner } from '../useBackgroundSigner'
import { shortAddr } from '../format'

function testRequest(): string {
  const pczt = dkgProvenPczt()
  const spends = parseAlphas(pczt).map((s) => ({ index: s.index, alpha: bytesToHex(s.alpha) }))
  return JSON.stringify({ kind: 'net-sign-request', sighash: bytesToHex(pcztSighash(pczt)), spends, pczt_hex: bytesToHex(pczt) })
}

export default function BackgroundSignerLab() {
  const [vaults, setVaults] = useState<VaultPublic[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [pass, setPass] = useState('')
  const [unlocked, setUnlocked] = useState<{ id: string } | null>(null)
  const [msg, setMsg] = useState('')

  // The lab auto-signs (gate open): this is a test digest, no funds. In the product the gate is the
  // per-vault governance policy (auto/manual + approval).
  const bg = useBackgroundSigner(unlocked, () => true)

  useEffect(() => {
    void (async () => {
      await init(wasmUrl)
      const vs = await listVaults()
      setVaults(vs)
      const already = vs.find((v) => getUnlockedShare(v.id))
      if (already) setUnlocked({ id: already.id })
    })()
  }, [])

  async function unlock() {
    if (!selected) return
    setMsg('')
    try {
      const v = await loadVault(selected, pass)
      setUnlockedShare(selected, v)
      setUnlocked({ id: selected })
      setPass('')
    } catch (e) {
      setMsg('Could not unlock: ' + String(e))
    }
  }

  return (
    <>
      <Letterhead right={<Link className="klab back" to="/lab">← Lab</Link>} />
      <main className="page" style={{ maxWidth: 640, margin: '0 auto' }}>
        <h1 className="klab" style={{ fontSize: 24, marginTop: 12 }}>Background signing (Stage 3)</h1>
        <p className="dim" style={{ marginTop: 6 }}>
          An unlocked vault signs a payment in the background, seated over the vault&apos;s signing room.
          Open this in two tabs on the same saved vault to watch them seat and co-sign. The message is a
          test digest (demo vector), never a broadcast.
        </p>

        {!unlocked && (
          <div className="confirm mt">
            {vaults.length === 0 ? (
              <p className="dim">No saved vaults on this device. Create + save one via <Link to="/net">/net</Link> first.</p>
            ) : (
              <>
                <div className="who-name mb-sm">Unlock a saved vault</div>
                {vaults.map((v) => (
                  <label key={v.id} className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="radio" name="vault" checked={selected === v.id} onChange={() => setSelected(v.id)} />
                    <span className="mono">{v.name || shortAddr(v.id, 8, 6)}</span>
                  </label>
                ))}
                <div className="field">
                  <input className="input mono" type="password" placeholder="Passphrase" value={pass}
                    onChange={(e) => setPass(e.target.value)} />
                </div>
                <button className="btn ok sm-btn" disabled={!selected || !pass} onClick={() => void unlock()}>Unlock</button>
                {msg && <p className="dim" style={{ color: 'var(--danger-text)' }}>{msg}</p>}
              </>
            )}
          </div>
        )}

        {unlocked && (
          <div className="fp-card mt">
            <div className="fp-head">
              <span className="klab">Signing room</span>
              <span className="mono dim">{bg.room ? shortAddr(bg.room, 8, 6) : '…'}</span>
            </div>
            <div className="db-meta" style={{ display: 'flex', gap: 20, marginTop: 8 }}>
              <div><span className="klab">Seats</span><br /><b>{bg.seatCount}</b></div>
              <div><span className="klab">State</span><br /><b>{bg.phase}</b></div>
              <div><span className="klab">Ready</span><br /><b>{bg.ready ? 'yes' : '…'}</b></div>
            </div>
            {bg.what && <p className="dim mt-sm">signing: {bg.what.zec} ZEC → {shortAddr(bg.what.addr, 10, 6)}</p>}
            {bg.signature && (
              <p className="mt-sm" style={{ color: bg.signature.ok ? 'var(--success)' : 'var(--danger-text)' }}>
                {bg.signature.ok ? '✓ verifying signature' : '✗ signature did not verify'}: <span className="mono">{shortAddr(bg.signature.hex, 10, 8)}</span>
              </p>
            )}
            {bg.error && <p className="dim" style={{ color: 'var(--danger-text)' }}>{bg.error}</p>}
            <button className="btn ghost sm-btn mt-sm" disabled={!bg.ready} onClick={() => void bg.inject(testRequest())}>
              Inject a test sign-request
            </button>
          </div>
        )}
      </main>
    </>
  )
}
