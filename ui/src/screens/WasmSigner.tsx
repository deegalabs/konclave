import { useState } from 'react'
import { Link } from 'react-router-dom'
import init, { TestVault, participantRound1, participantRound2, Coordinator } from '../wasm-pkg/konclave_wasm.js'
import wasmUrl from '../wasm-pkg/konclave_wasm_bg.wasm?url'
import '../redesign.css'

type Result = { ok: boolean; msg: string } | null

/** konclave.app proof: a full 2-of-3 rerandomized redpallas FROST ceremony run entirely in
 *  WebAssembly, in the browser — the secret share never leaves, only public material moves. */
export default function WasmSigner() {
  const [result, setResult] = useState<Result>(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true); setResult(null)
    try {
      const t0 = performance.now()
      await init(wasmUrl)
      const message = new TextEncoder().encode('konclave: an Orchard sighash would go here (demo)')
      const v = new TestVault() // trusted-dealer 2-of-3, standing in for the unlocked device shares
      // two devices, round 1 — nonces stay local, commitments go to the coordinator
      const a = participantRound1(v.key_package(0))
      const b = participantRound1(v.key_package(1))
      const coord = new Coordinator(v.groupVk(), v.pubkeys(), message)
      coord.addCommitment(v.id(0), a.commitment())
      coord.addCommitment(v.id(1), b.commitment())
      coord.prepare()
      const sp = coord.signingPackage(); const seed = coord.seed()
      // round 2 — each device signs with ITS local nonces
      coord.addShare(v.id(0), participantRound2(sp, a.nonces(), v.key_package(0), seed))
      coord.addShare(v.id(1), participantRound2(sp, b.nonces(), v.key_package(1), seed))
      const sig = coord.aggregate()
      const ok = coord.verify(sig)
      const ms = Math.round(performance.now() - t0)
      setResult({ ok, msg: ok ? `Assinatura FROST redpallas de ${sig.length} bytes — verificada · ${ms}ms` : 'A verificação falhou' })
    } catch (e) {
      setResult({ ok: false, msg: 'Erro: ' + (e instanceof Error ? e.message : String(e)) })
    }
    setBusy(false)
  }

  return (
    <div className="rd" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ maxWidth: 540, textAlign: 'center' }}>
        <span className="rd-eyebrow">konclave.app · prova no navegador</span>
        <h1 style={{ fontSize: 29, fontWeight: 800, letterSpacing: '-.02em', margin: '10px 0 0' }}>Assinar FROST no navegador</h1>
        <p style={{ color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.65 }}>
          Roda uma cerimônia <b style={{ color: 'var(--text)' }}>2-de-3 rerandomized redpallas</b> (o caminho de assinatura do Orchard)
          inteiramente em <b style={{ color: 'var(--text)' }}>WebAssembly, aqui no seu navegador</b>. A parte secreta (share + nonces)
          nunca sai do device — só material público circula, como no relay cego.
        </p>
        <button className="btn ok" style={{ marginTop: 24 }} onClick={() => void run()} disabled={busy}>
          {busy ? 'Assinando…' : '▸ Assinar no navegador'}
        </button>
        {result && (
          <div style={{
            marginTop: 20, padding: '14px 16px', borderRadius: 12, fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.5,
            border: `1px solid ${result.ok ? 'var(--success-line)' : 'var(--danger-line)'}`,
            background: result.ok ? 'var(--success-soft)' : 'var(--danger-soft)',
            color: result.ok ? 'var(--success)' : 'var(--danger-text)',
          }}>
            {result.ok ? '✓ ' : '✗ '}{result.msg}
          </div>
        )}
        <div style={{ marginTop: 24 }}><Link className="rd-link" to="/intro">← voltar</Link></div>
      </div>
    </div>
  )
}
