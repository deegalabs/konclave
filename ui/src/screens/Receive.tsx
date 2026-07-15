import { useEffect, useMemo, useState } from 'react'
import encodeQR from '@paulmillr/qr'
import { getVault, type Vault } from '../api'
import { useI18n } from '../i18n'
import '../receive.css'

// "Add funds" is the easy side of a vault: receiving needs no key and no signature. The vault
// has a shielded Orchard address (derived from the group key by zcash-sign); anyone sends ZEC to
// it and the balance appears once the vault syncs. This screen shows the address, a QR, and a
// ZIP-321 payment link a phone wallet can open. All client-side; nothing leaves the browser.

const TXT = {
  'pt-BR': {
    title: 'Receber no cofre',
    lead: 'Mande ZEC para o endereço Orchard do cofre. Receber não usa a chave: qualquer carteira pode enviar, e o saldo aparece quando o cofre sincroniza.',
    address: 'Endereço do cofre (Orchard, blindado)',
    copy: 'Copiar endereço',
    copied: 'Copiado',
    amount: 'Valor (opcional, ZEC)',
    uri: 'Link de pagamento (ZIP-321)',
    copyUri: 'Copiar link',
    openWallet: 'Abrir na carteira',
    note: 'Só Orchard. Um endereço transparente ou Sapling não recebe deste cofre.',
    noVault: 'Nenhum cofre neste dispositivo.',
  },
  en: {
    title: 'Add funds to the vault',
    lead: 'Send ZEC to the vault’s Orchard address. Receiving never touches the key: any wallet can send, and the balance appears once the vault syncs.',
    address: 'Vault address (Orchard, shielded)',
    copy: 'Copy address',
    copied: 'Copied',
    amount: 'Amount (optional, ZEC)',
    uri: 'Payment link (ZIP-321)',
    copyUri: 'Copy link',
    openWallet: 'Open in wallet',
    note: 'Orchard only. A transparent or Sapling address will not receive from this vault.',
    noVault: 'No vault on this device.',
  },
} as const

export default function Receive() {
  const { locale } = useI18n()
  const T = TXT[locale] ?? TXT.en
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
      <div className="rcv">
        <p className="rcv-lead">{T.noVault}</p>
      </div>
    )
  }

  return (
    <div className="rcv">
      <h1 className="rcv-h1">{T.title}</h1>
      <p className="rcv-lead">{T.lead}</p>

      <div className="rcv-grid">
        <div className="rcv-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} role="img" aria-label="QR" />

        <div className="rcv-side">
          <span className="rcv-label">{T.address}</span>
          <div className="rcv-addr">{address}</div>
          <button className="rcv-btn" onClick={() => copy(address, 'a')}>
            {copied === 'a' ? T.copied : T.copy}
          </button>

          <span className="rcv-label" style={{ marginTop: 18 }}>{T.amount}</span>
          <input
            className="rcv-input"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />

          <span className="rcv-label" style={{ marginTop: 18 }}>{T.uri}</span>
          <div className="rcv-uri">{uri}</div>
          <div className="rcv-actions">
            <button className="rcv-btn" onClick={() => copy(uri, 'u')}>
              {copied === 'u' ? T.copied : T.copyUri}
            </button>
            <a className="rcv-btn primary" href={uri}>{T.openWallet}</a>
          </div>
        </div>
      </div>

      <p className="rcv-note">{T.note}</p>
    </div>
  )
}
