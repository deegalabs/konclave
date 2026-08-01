import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Seal } from '../components'
import { PageHeader, PageFooter } from '../page'
import { useI18n } from '../i18n'
import { getVault, health, shortAddr, deleteVault, type Vault } from '../api'

/**
 * Per-vault settings (redesign Fase 0). Shows the vault's public identity (quorum, group,
 * address, members) and the local-device controls: the unlock method and "remove from this
 * device". Network is shown only once the vault carries it (Fase 2 wires per-vault network);
 * until then we do not invent one. Copy is inline-bilingual, matching the other new screens.
 */
export default function Settings() {
  const { locale } = useI18n()
  const pe = (pt: string, en: string) => (locale === 'pt-BR' ? pt : en)
  const nav = useNavigate()
  const [vault, setVault] = useState<Vault | null>(null)
  const [live, setLive] = useState<boolean | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let on = true
    void (async () => {
      const ok = await health()
      if (!on) return
      setLive(ok)
      if (ok) {
        const v = await getVault()
        if (on && v) setVault(v)
      }
    })()
    return () => { on = false }
  }, [])

  const thr = vault?.threshold ?? 2
  const n = vault?.total ?? 3
  const network = (vault as unknown as { network?: string } | null)?.network

  async function removeFromDevice() {
    if (!vault || confirmName.trim() !== vault.name) return
    setBusy(true)
    setErr(null)
    const res = await deleteVault(undefined, confirmName.trim())
    setBusy(false)
    if (res.ok) { nav('/vaults'); return }
    setErr(res.wrong
      ? pe('Nome não confere.', 'Name does not match.')
      : pe('Não foi possível remover agora.', 'Could not remove right now.'))
  }

  return (
    <main className="page">
      <PageHeader
        eyebrow={pe('AJUSTES', 'SETTINGS')}
        title={pe('Ajustes', 'Settings')}
        subtitle={<>
          {vault?.name ?? pe('Cofre', 'Vault')} · {pe('quórum', 'quorum')} {thr}/{n}
          {live === false && <span className="livetag off"> {pe('demo', 'demo')}</span>}
        </>}
        actions={<Seal t={thr} n={n} />}
      />

      <div className="set-list mt">
        {network && (
          <div className="set-row">
            <span className="set-k">{pe('Rede', 'Network')}</span>
            <span className="set-v"><span className="set-badge">{network === 'test' ? 'testnet' : 'mainnet'}</span></span>
          </div>
        )}
        <div className="set-row">
          <span className="set-k">{pe('Quórum', 'Quorum')}</span>
          <span className="set-v">{thr} {pe('de', 'of')} {n}</span>
        </div>
        <div className="set-row">
          <span className="set-k">{pe('Membros', 'Members')}</span>
          <span className="set-v">{vault?.member_list?.length ?? n}</span>
        </div>
        <div className="set-row">
          <span className="set-k">{pe('Endereço', 'Address')}</span>
          <span className="set-v mono">{vault ? shortAddr(vault.orchard_address) : '—'}</span>
        </div>
        <div className="set-row">
          <span className="set-k">{pe('Grupo (DKG)', 'Group (DKG)')}</span>
          <span className="set-v mono">{vault ? vault.group_pubkey.slice(0, 10) + '…' : '—'}</span>
        </div>
        <div className="set-row">
          <span className="set-k">{pe('Desbloqueio', 'Unlock')}</span>
          <span className="set-v">{pe('senha neste aparelho', 'passphrase on this device')}</span>
        </div>
      </div>

      <section className="set-danger mt">
        <h2 className="set-danger-title">{pe('Zona sensível', 'Danger zone')}</h2>
        <p className="set-danger-note">
          {pe(
            'Remove o cofre só deste aparelho. Os outros membros continuam com os seus pedaços; nada é apagado da rede.',
            'Removes the vault from this device only. The other members keep their shares; nothing is deleted from the network.',
          )}
        </p>
        {!confirming ? (
          <button type="button" className="btn danger-btn" onClick={() => setConfirming(true)}>
            {pe('Remover deste aparelho', 'Remove from this device')}
          </button>
        ) : (
          <div className="set-confirm">
            <label className="set-confirm-label">
              {pe('Digite o nome do cofre para confirmar:', 'Type the vault name to confirm:')}
              <input
                className="set-input"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={vault?.name ?? ''}
                autoFocus
              />
            </label>
            {err && <p className="set-err">{err}</p>}
            <div className="set-confirm-actions">
              <button
                type="button"
                className="btn danger-btn"
                disabled={busy || confirmName.trim() !== vault?.name}
                onClick={removeFromDevice}
              >
                {busy ? pe('Removendo…', 'Removing…') : pe('Confirmar remoção', 'Confirm removal')}
              </button>
              <button type="button" className="btn ghost" onClick={() => { setConfirming(false); setConfirmName(''); setErr(null) }}>
                {pe('Cancelar', 'Cancel')}
              </button>
            </div>
          </div>
        )}
      </section>

      <PageFooter>{pe('Konclave · ajustes do cofre', 'Konclave · vault settings')}</PageFooter>
    </main>
  )
}
