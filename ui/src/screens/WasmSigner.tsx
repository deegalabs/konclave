import { useState } from 'react'
import { Link } from 'react-router-dom'
import init, {
  TestVault,
  participantRound1,
  participantRound2,
  Coordinator,
  describeOutputs,
  extractRandomizers,
  injectSigs,
} from '../wasm-pkg/konclave_wasm.js'
import wasmUrl from '../wasm-pkg/konclave_wasm_bg.wasm?url'
import { useT, useTr, useI18n } from '../i18n'
import { Letterhead } from '../components'
import {
  dkgProvenPczt,
  dkgBroadcastSig,
  DKG_SIGHASH,
  DKG_TXID,
  DKG_SPEND_INDEX,
} from '../demo-vector'
import '../redesign.css'
import '../net.css'

type Result = { ok: boolean; msg: string } | null
type RealResult =
  | { ok: true; recipient: string; zec: string; index: number; alpha: string; signedLen: number }
  | { ok: false; msg: string }
  | null

const hexToBytes = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const short = (s: string) => (s.length > 24 ? `${s.slice(0, 14)}…${s.slice(-6)}` : s)

/** konclave.app proof: a full 2-of-3 rerandomized redpallas FROST ceremony run entirely in
 *  WebAssembly, in the browser — the secret share never leaves, only public material moves.
 *  Plus the FROST↔PCZT bridge operating on a real mainnet transaction. */
export default function WasmSigner() {
  const t = useT()
  const tr = useTr()
  const { locale } = useI18n()
  const L = (pt: string, en: string) => (locale === 'pt-BR' ? pt : en)
  const [result, setResult] = useState<Result>(null)
  const [busy, setBusy] = useState(false)
  const [real, setReal] = useState<RealResult>(null)
  const [realBusy, setRealBusy] = useState(false)

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
      setResult({ ok, msg: ok ? t('signer.resultOk', { bytes: sig.length, ms }) : t('signer.resultFail') })
    } catch (e) {
      setResult({ ok: false, msg: t('signer.error', { msg: e instanceof Error ? e.message : String(e) }) })
    }
    setBusy(false)
  }

  // The FROST↔PCZT bridge on a REAL mainnet transaction: read what it pays, extract the randomizer,
  // and reconstruct the exact signed PCZT that was broadcast. (The signature was produced by the
  // vault's real ceremony; here the browser reads and reconstructs it — it does not re-sign.)
  async function runReal() {
    setRealBusy(true); setReal(null)
    try {
      await init(wasmUrl)
      const proven = dkgProvenPczt()
      const outs = JSON.parse(describeOutputs(proven)) as { address: string | null; value: number | null }[]
      const recipient = outs.find((o) => o.address !== null)
      if (!recipient || recipient.value == null || recipient.address == null) throw new Error('no addressed recipient')
      const rands = extractRandomizers(proven)
      const index = new DataView(rands.buffer, rands.byteOffset, 4).getUint32(0, true)
      const alpha = toHex(rands.slice(4, 36))
      const sigs = new Uint8Array(68)
      new DataView(sigs.buffer).setUint32(0, DKG_SPEND_INDEX, true)
      sigs.set(dkgBroadcastSig(), 4)
      const signed = injectSigs(proven, hexToBytes(DKG_SIGHASH), sigs)
      setReal({
        ok: true,
        recipient: recipient.address,
        zec: (recipient.value / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''),
        index,
        alpha,
        signedLen: signed.length,
      })
    } catch (e) {
      setReal({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    }
    setRealBusy(false)
  }

  return (
    <div className="rd demo-page">
      <Letterhead />
      <div className="demo-main">
        <div className="demo-col">
          <span className="demo-eyebrow"><span className="dot" aria-hidden="true" />{t('demo.live')}</span>
          <h1 className="demo-title">{t('signer.title')}</h1>
          <p className="demo-caption">{t('signer.eyebrow')}</p>
          <p className="demo-lead">{tr('signer.lead')}</p>
          <button className="btn ok" style={{ marginTop: 22 }} onClick={() => void run()} disabled={busy}>
            {busy ? t('signer.signing') : t('signer.btn')}
          </button>
          {result && (
            <div className={'demo-result ' + (result.ok ? 'ok' : 'bad')}>
              {result.ok ? '✓ ' : '✗ '}{result.msg}
            </div>
          )}

          <hr style={{ margin: '30px 0', border: 'none', borderTop: '1px solid var(--rd-line)' }} />

          <h2 className="demo-title" style={{ fontSize: '1.15rem' }}>
            {L('O bridge numa transação real da mainnet', 'The bridge on a real mainnet transaction')}
          </h2>
          <p className="demo-lead">
            {L(
              'O mesmo bridge FROST↔PCZT, em WebAssembly, lê a transação real do envio de cofre DKG (o quê ela paga), extrai o randomizer e reconstrói a PCZT assinada — a mesma que foi transmitida à mainnet. O navegador lê e reconstrói; a assinatura veio da cerimônia real do cofre.',
              'The same FROST↔PCZT bridge, in WebAssembly, reads the real DKG-vault send (what it pays), extracts the randomizer, and reconstructs the signed PCZT — the very one broadcast to mainnet. The browser reads and reconstructs; the signature came from the vault’s real ceremony.',
            )}
          </p>
          <button className="btn" style={{ marginTop: 18 }} onClick={() => void runReal()} disabled={realBusy}>
            {realBusy ? L('Lendo…', 'Reading…') : L('Ler a PCZT real no navegador', 'Read the real PCZT in the browser')}
          </button>
          {real && real.ok && (
            <div className="demo-result ok" style={{ display: 'grid', gap: 6, textAlign: 'left' }}>
              <div>
                <strong>{L('Paga', 'Pays')}</strong> {real.zec} ZEC → <code>{short(real.recipient)}</code>{' '}
                <span style={{ opacity: 0.7 }}>({L('o que você confirmaria antes de assinar', 'what you would confirm before signing')})</span>
              </div>
              <div>
                <strong>{L('Gasto real', 'Real spend')}</strong> {L('na ação', 'at action')} #{real.index} · α <code>{short(real.alpha)}</code>
              </div>
              <div>
                <strong>{L('Reconstruída', 'Reconstructed')}</strong> {real.signedLen} bytes {L('assinados', 'signed')} = {L('a tx transmitida como', 'the tx broadcast as')}{' '}
                <Link className="rd-link" to="/proof"><code>{short(DKG_TXID)}</code></Link>
              </div>
            </div>
          )}
          {real && !real.ok && <div className="demo-result bad">✗ {real.msg}</div>}

          <div className="demo-back"><Link className="rd-link" to="/intro">{t('signer.back')}</Link></div>
        </div>
      </div>
    </div>
  )
}
