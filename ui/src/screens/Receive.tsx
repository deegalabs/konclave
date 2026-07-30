import { useEffect, useMemo, useState } from 'react'
import encodeQR from '@paulmillr/qr'
import { getVault, type Vault } from '../api'
import { useT } from '../i18n'
import { PageHeader, NextStep } from '../page'
import '../receive.css'

// "Add funds" is the easy side of a vault: receiving needs no key and no signature. The vault
// has a shielded Orchard address (derived from the group key by zcash-sign); anyone sends ZEC to
// it and the balance appears once the vault syncs. This screen shows the address, a QR, and a
// ZIP-321 payment link a phone wallet can open. All client-side; nothing leaves the browser.

export default function Receive() {
  const t = useT()
  const [vault, setVault] = useState<Vault | null>(null)
  const [amount, setAmount] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let on = true
    void getVault().then((v) => {
      if (on && v) setVault(v)
    })
    return () => {
      on = false
    }
  }, [])

  const address = vault?.orchard_address ?? ''
  const uri = useMemo(() => {
    if (!address) return ''
    const amt = amount.trim()
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
        <p className="rcv-note">{t('receive.noVault')}</p>
      </main>
    )
  }

  return (
    <main className="page rcv">
      <PageHeader title={t('receive.title')} subtitle={t('receive.lead')} />

      <div className="rcv-grid">
        <div className="rcv-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} role="img" aria-label="QR" />

        <div className="rcv-side">
          <span className="rcv-label">{t('receive.address')}</span>
          <div className="rcv-addr">{address}</div>
          <button className="rcv-btn" onClick={() => copy(address, 'a')}>
            {copied === 'a' ? t('receive.copied') : t('receive.copy')}
          </button>

          <span className="rcv-label" style={{ marginTop: 18 }}>{t('receive.amount')}</span>
          <input
            className="rcv-input"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />

          <span className="rcv-label" style={{ marginTop: 18 }}>{t('receive.uri')}</span>
          <div className="rcv-uri">{uri}</div>
          <div className="rcv-actions">
            <button className="rcv-btn" onClick={() => copy(uri, 'u')}>
              {copied === 'u' ? t('receive.copied') : t('receive.copyUri')}
            </button>
            <a className="rcv-btn primary" href={uri}>{t('receive.openWallet')}</a>
          </div>
        </div>
      </div>

      <p className="rcv-note">{t('receive.note')}</p>

      <NextStep label={t('next.label')} cta={t('next.dashboard')} to="/dashboard" />
    </main>
  )
}
