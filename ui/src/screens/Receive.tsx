import { useEffect, useMemo, useState } from 'react'
import encodeQR from '@paulmillr/qr'
import { getVault, getTransactions, shortAddr, IS_NET, type Vault, type WalletTx } from '../api'
import { useT, useTr } from '../i18n'
import { PageHeader } from '../page'
import { Loading } from '../components'
import '../receive.css'

// "Add funds" is the easy side of a vault: receiving needs no key and no signature. The vault
// has a shielded Orchard address (derived from the group key by zcash-sign); anyone sends ZEC to
// it and the balance appears once the vault syncs. This screen shows the address, a QR, and a
// ZIP-321 payment link a phone wallet can open. All client-side; nothing leaves the browser.

export default function Receive() {
  const t = useT()
  const tr = useTr()
  const [vault, setVault] = useState<Vault | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [amount, setAmount] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  // The vault's full on-chain record since creation (browser-native path). Loaded once; the txids
  // link to a block explorer where the amounts are visible (per-tx amount/direction is a follow-up).
  const [txs, setTxs] = useState<WalletTx[] | null>(null)
  const [txLoaded, setTxLoaded] = useState(false)

  useEffect(() => {
    let on = true
    void getVault().then((v) => {
      if (!on) return
      if (v) setVault(v)
      setLoaded(true)
    })
    // Auto-refresh the history (#123): a deposit that lands on-chain shows up without a reload.
    // In-flight guarded; polls on the shared 15s cadence.
    let inFlight = false
    const loadTx = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const r = await getTransactions()
        if (on) { setTxs(r); setTxLoaded(true) }
      } finally {
        inFlight = false
      }
    }
    void loadTx()
    const id = setInterval(() => void loadTx(), 15_000)
    return () => {
      on = false
      clearInterval(id)
    }
  }, [])

  const address = vault?.orchard_address ?? ''
  const uri = useMemo(() => {
    if (!address) return ''
    const raw = amount.trim().replace(',', '.')
    // Only a well-formed positive number becomes a ZIP-321 amount; anything else is ignored so the
    // URI/QR never carries a malformed value.
    const amt = /^\d+(\.\d+)?$/.test(raw) && Number(raw) > 0 ? raw : ''
    return `zcash:${address}${amt ? `?amount=${encodeURIComponent(amt)}` : ''}`
  }, [address, amount])

  const qrSvg = useMemo(() => {
    if (!uri) return ''
    try {
      return encodeQR(uri, 'svg')
    } catch {
      return ''
    }
  }, [uri])

  const copy = (text: string, tag: string) => {
    void navigator.clipboard?.writeText(text)
    setCopied(tag)
    setTimeout(() => setCopied(null), 1600)
  }

  if (!vault) {
    return (
      <main className="page">
        <PageHeader title={t('receive.title')} />
        {loaded ? <p className="rcv-note">{t('receive.noVault')}</p> : <Loading />}
      </main>
    )
  }

  return (
    <main className="page rcv">
      <PageHeader title={t('receive.title')} subtitle={t('receive.lead')} />

      <div className="rcv-grid">
        <div className="rcv-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} role="img" aria-label={t('receive.qrAlt')} />

        <div className="rcv-side">
          <span className="klab">{t('receive.address')}</span>
          <div className="rcv-addr">{address}</div>
          <div className="rcv-actions">
            <button className="btn" onClick={() => copy(address, 'a')}>
              {copied === 'a' ? t('receive.copied') : t('receive.copy')}
            </button>
          </div>

          <label className="field"><span>{t('receive.amount')}</span>
            <input
              className="input mono"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>

          <span className="klab" style={{ marginTop: 4 }}>{t('receive.uri')}</span>
          <div className="rcv-uri">{uri}</div>
          <div className="rcv-actions">
            <button className="btn" onClick={() => copy(uri, 'u')}>
              {copied === 'u' ? t('receive.copied') : t('receive.copyUri')}
            </button>
            <a className="btn ok" href={uri}>{t('receive.openWallet')}</a>
          </div>
        </div>
      </div>

      <p className="rcv-note">{t('receive.note')}</p>

      {/* On-chain history: every transaction this vault recorded since creation. Browser-native
          only (the bridge/desktop path is a follow-up); each row links to a block explorer. */}
      {IS_NET && (
        <section className="rcv-history">
          <div className="rcv-hist-head">
            <span className="klab">{t('receive.historyTitle')}</span>
          </div>
          {!txLoaded ? (
            <Loading />
          ) : !txs || txs.length === 0 ? (
            <p className="rcv-note">{t('receive.historyEmpty')}</p>
          ) : (
            <div className="rcv-hist-list">
              {txs.map((x) => (
                <div className="rcv-hist-row" key={x.txid}>
                  <code className="rcv-hist-txid mono">{shortAddr(x.txid, 10, 8)}</code>
                  <span className={'rcv-hist-state' + (x.mined_height ? ' ok' : '')}>
                    {x.mined_height ? t('receive.txConfirmed', { h: x.mined_height }) : t('receive.txPending')}
                  </span>
                  <a className="link" href={`https://mainnet.zcashexplorer.app/transactions/${x.txid}`} target="_blank" rel="noreferrer">{t('receive.viewTx')} ↗</a>
                </div>
              ))}
            </div>
          )}
          <p className="rcv-note dim">{tr('receive.historyNote')}</p>
        </section>
      )}
    </main>
  )
}
