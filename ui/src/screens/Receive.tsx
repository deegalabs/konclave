import { useEffect, useId, useMemo, useState } from 'react'
import { SkeletonDetail, SkeletonQr, SkeletonRows } from '../skeleton'
import { startVisiblePoll } from '../usePoll'
import encodeQR from '@paulmillr/qr'
import { getVault, readTransactions, getLedger, shortAddr, IS_NET, type Vault, type WalletTx } from '../api'
import { useI18n, useT, useTr } from '../i18n'
import { PageHeader } from '../page'
import { BannerWarn } from '../components'
import ReadState from '../ReadState'
import { getSelectedVault } from '../api'
import { lastReadFailure } from '../read-failure'
import '../receive.css'
import { historyReadKind, historyReader, isHistoryAnswer } from '../useVaultBalance'
import { useVaultReadable } from '../vault-readable'
import { amountAmbiguous, fmtZecExact, typedAmountZat } from '../format'
import { copyText } from '../clipboard'

// "Add funds" is the easy side of a vault: receiving needs no key and no signature. The vault
// has a shielded Orchard address (derived from the group key by zcash-sign); anyone sends ZEC to
// it and the balance appears once the vault syncs. This screen shows the address, a QR, and a
// ZIP-321 payment link a phone wallet can open. All client-side; nothing leaves the browser.

/** What Receive says about the vault's address before it shows one (A9, #610 review). The address
 *  is the one this device recorded (`getVault`). When the coordinator answers with another, the
 *  member is told before copying anything, and the coordinator's address is never shown: showing it
 *  would offer it to copy. With no record there is no address to show, and the screen says why.
 *  Exported for its test: the screen loads the vault in an effect, which server rendering never runs. */
export function AddressNotice({ differs, missing, id }: { differs: boolean; missing: boolean; id: string }) {
  const t = useT()
  const tr = useTr()
  if (missing) {
    return (
      <div id={id}>
        <p className="rcv-note">{t('receive.noAddress')}</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>{t('receive.reload')}</button>
      </div>
    )
  }
  if (!differs) return null
  return <BannerWarn id={id} className="rcv-warn">{tr('receive.addressDiffers')}</BannerWarn>
}

/** Whether the on-chain history is being read right now, and when it last answered. The list fills in
 *  from the coordinator's sync, which can take a while, so without this an empty list read as an
 *  answer while a deposit was still on its way in. The time stays on screen while a read runs. It is
 *  not a live region: a status that changes every 15 s would talk over the member reading the
 *  address (a11y audit); announcing a new deposit when it lands is the follow-up. The spinner and
 *  its label are decorative. Exported for its test. */
export function HistoryStatus({ checking, checkedAt, failed = false }: { checking: boolean; checkedAt: number | null; failed?: boolean }) {
  const { locale, t } = useI18n()
  const time = checkedAt === null ? null
    : new Date(checkedAt).toLocaleTimeString(locale === 'en' ? 'en-US' : 'pt-BR', { hour: '2-digit', minute: '2-digit' })
  return (
    <span className="rcv-hist-status">
      {checking ? (
        <span className="rcv-hist-checking" aria-hidden="true">
          <span className="loader-ring sm" />
          {t('receive.historyChecking')}
        </span>
      ) : failed ? (
        <span>{t('receive.historyRetry')}</span>
      ) : null}
      {time && <span>{t('receive.historyChecked', { time })}</span>}
    </span>
  )
}

export default function Receive() {
  const t = useT()
  const tr = useTr()
  const noticeId = useId()
  const readable = useVaultReadable()
  const [vault, setVault] = useState<Vault | null>(null)
  const [loaded, setLoaded] = useState(false)
  // A vault that could not be read is said as such, never as "no vault on this device" (#320).
  const [attempt, setAttempt] = useState(0)
  const [retrying, setRetrying] = useState(false)
  // Set from the read's answer, never read off the module during render: a failure left behind by
  // an earlier vault must not outlive a device that now holds none.
  const [unread, setUnread] = useState<ReturnType<typeof lastReadFailure>>(null)
  const [amount, setAmount] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  // #313: said only after the clipboard confirmed the write; a refusal is said instead.
  const [copyErr, setCopyErr] = useState(false)
  // The vault's full on-chain record since creation (browser-native path). Loaded once; the txids
  // link to a block explorer where the amounts are visible (per-tx amount/direction is a follow-up).
  const [txs, setTxs] = useState<WalletTx[] | null>(null)
  const [txLoaded, setTxLoaded] = useState(false)
  // A history read in flight (the first one and every refresh), and the time the last one answered.
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  // The last read failed (not busy: failed). Said, and retried soon.
  const [failed, setFailed] = useState(false)
  // The vault's OWN broadcast txids (from the ledger). A history tx whose id is in here is a SENT
  // (outgoing) payment this vault made; anything else is a RECEIVED deposit. This gives direction
  // client-side, without needing the tool's per-tx amount/direction fields (#125 v2 slice).
  const [sentIds, setSentIds] = useState<Set<string>>(new Set())

  // One read for the first load and for every retry (two copies of it drift).
  const loadVault = async (first: boolean) => {
    const v = await getVault()
    if (v) { setVault(v); setUnread(null) } else {
      const why = getSelectedVault() ? lastReadFailure('/api/vault') : null
      setUnread(why)
      if (!first && why) setAttempt((a) => a + 1)
    }
    setLoaded(true)
  }
  useEffect(() => { void loadVault(true) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const retryVault = async () => { setRetrying(true); try { await loadVault(false) } finally { setRetrying(false) } }

  // The history is a private read: behind the unlock overlay it would answer 401, which is a failure,
  // not an empty history. So it waits until `useVaultReadable` says the vault is unlocked, and reads
  // again the moment it is (#439, #467). The reader keeps one read at a time and retries a
  // failure on a short schedule that stops; the 15 s poll does the rest (#123), paused when hidden.
  useEffect(() => {
    if (!readable) return
    let on = true
    const reader = historyReader<WalletTx>({
      read: () => readTransactions(),
      onStart: () => {
        // "Checking" is exactly the /api/vault/transactions request in flight (Daniel, 16/10). The
        // ledger (which txids this vault sent) is read beside it and does not hold the spinner.
        setChecking(true)
        void getLedger().then((ledger) => {
          if (on && ledger) setSentIds(new Set(ledger.map((p) => p.txid).filter((x): x is string => !!x)))
        })
      },
      onResult: (r) => {
        setChecking(false)
        // Only an answer fills the list and counts as a check; busy and failed keep what is shown.
        if (isHistoryAnswer(r)) {
          setTxs(r)
          setTxLoaded(true)
          setCheckedAt(Date.now())
        }
        setFailed(historyReadKind(r) === 'failed')
      },
    })
    reader.tick()
    const stop = startVisiblePoll(reader.tick, 15_000)
    return () => {
      on = false
      reader.stop()
      stop()
    }
  }, [readable])

  const address = vault?.orchard_address ?? ''
  // Each control that hands the address on carries the warning, so a screen reader that missed the
  // one announcement hears it again on the control it is about to use.
  const describedBy = vault?.served_address_differs ? noticeId : undefined
  const uri = useMemo(() => {
    if (!address) return ''
    // Only an amount the vault could pay becomes a ZIP-321 amount (the same rule as the pay screen,
    // at most 8 decimals); anything else is ignored so the URI/QR never carries a malformed value.
    const zat = typedAmountZat(amount)
    const amt = zat != null && zat > 0 ? fmtZecExact(zat / 1e8) : ''
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

  const copy = async (text: string, tag: string) => {
    const ok = await copyText(text)
    setCopyErr(!ok)
    if (!ok) return
    setCopied(tag)
    setTimeout(() => setCopied(null), 1600)
  }

  if (!vault) {
    return (
      <main className="page">
        <PageHeader title={t('receive.title')} />
        {!loaded ? <div className="rcv-grid"><SkeletonQr /><SkeletonDetail rows={3} status={false} /></div> : unread
          ? <ReadState title={t('receive.unreadTitle')} failure={unread} attempt={attempt} busy={retrying} onRetry={() => void retryVault()} holds={t('receive.holds')} />
          : <p className="rcv-note">{t('receive.noVault')}</p>}
      </main>
    )
  }

  return (
    <main className="page rcv">
      {/* Without an address, the lead's "send ZEC to the vault's address" has nothing to point at. */}
      <PageHeader title={t('receive.title')} subtitle={address ? t('receive.lead') : undefined} />

      <AddressNotice differs={!!vault.served_address_differs} missing={!address} id={noticeId} />

      {address && (
      <div className="rcv-grid">
        {qrSvg
          ? <div className="rcv-qr" dangerouslySetInnerHTML={{ __html: qrSvg }} role="img" aria-label={t('receive.qrAlt')} />
          : <div className="rcv-qr rcv-qr-off"><p className="rcv-note">{t('receive.qrFailed')}</p></div>}

        <div className="rcv-side">
          <span className="klab">{t('receive.address')}</span>
          <div className="rcv-addr">{address}</div>
          <div className="rcv-actions">
            <button className="btn" onClick={() => void copy(address, 'a')} aria-describedby={describedBy}>
              {copied === 'a' ? t('receive.copied') : t('receive.copy')}
            </button>
          </div>
          {/* The button's label changes, which a screen reader does not read on its own: one live
              region says "Copied" for either button (#320). */}
          <span className="visually-hidden" role="status">{copied ? t('receive.copied') : ''}</span>
          <div role="alert">{copyErr && <div className="hint warn mt-sm">{t('receive.copyErr')}</div>}</div>

          <label className="field"><span>{t('receive.amount')}</span>
            <input
              className="input mono"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          {/* The same rule and sentence as the pay screen: an ambiguous amount is left out of the
              request, and the member is told why rather than finding it missing from the link. */}
          {amountAmbiguous(amount) && <div className="hint warn" role="status">{t('money.blockAmountAmbiguous')}</div>}

          <span className="klab" style={{ marginTop: 4 }}>{t('receive.uri')}</span>
          <div className="rcv-uri">{uri}</div>
          <div className="rcv-actions">
            <button className="btn" onClick={() => void copy(uri, 'u')} aria-describedby={describedBy}>
              {copied === 'u' ? t('receive.copied') : t('receive.copyUri')}
            </button>
            <a className="btn ok" href={uri} aria-describedby={describedBy}>{t('receive.openWallet')}</a>
          </div>
        </div>
      </div>
      )}

      {address && <p className="rcv-note">{t('receive.note')}</p>}

      {/* On-chain history: every transaction this vault recorded since creation. Browser-native
          only (the bridge/desktop path is a follow-up); each row links to a block explorer. */}
      {IS_NET && (
        <section className="rcv-history">
          <div className="rcv-hist-head">
            <span className="klab">{t('receive.historyTitle')}</span>
            {txLoaded && <HistoryStatus checking={checking} checkedAt={checkedAt} failed={failed} />}
          </div>
          {!txLoaded ? (
            failed && !checking ? <p className="rcv-note">{t('receive.historyUnreadable')}</p> : <SkeletonRows n={3} compact />
          ) : !txs || txs.length === 0 ? (
            <p className="rcv-note">{t('receive.historyEmpty')}</p>
          ) : (
            <div className="rcv-hist-list">
              {txs.map((x) => {
                const sent = sentIds.has(x.txid)
                return (
                  <div className="rcv-hist-row" key={x.txid}>
                    <span className={'rcv-hist-dir ' + (sent ? 'out' : 'in')}>
                      {sent ? t('receive.txSent') : t('receive.txReceived')}
                    </span>
                    <code className="rcv-hist-txid mono">{shortAddr(x.txid, 10, 8)}</code>
                    <span className={'rcv-hist-state' + (x.mined_height ? ' ok' : '')}>
                      {x.mined_height ? t('receive.txConfirmed', { h: x.mined_height }) : t('receive.txPending')}
                    </span>
                    <a className="link" href={`https://mainnet.zcashexplorer.app/transactions/${x.txid}`} target="_blank" rel="noreferrer">{t('receive.viewTx')} ↗</a>
                  </div>
                )
              })}
            </div>
          )}
          <p className="rcv-note dim">{tr('receive.historyNote')}</p>
        </section>
      )}
    </main>
  )
}
