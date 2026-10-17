import { describe, expect, it } from 'vitest'
import * as session from './session'
import { panelConnecting } from './screens/SigningPanel'
import { signerVault } from './VaultSigner'
import { unlockWithPasskeyUsing } from './passkey-unlock'
import { codeOf } from './source-scan'

// Final staging run, 16/10: a member who created a vault and then opened a payment on the same page,
// without reloading, saw the signing panel stay at "Connecting to the signing room" with no error;
// a reload and an unlock cured it. Two answers to "is this vault unlocked here?" disagreed: the panel
// read whether the share is in this session (getUnlockedShare), and the background signer read
// whether the vault went through the unlock screen (isVaultUnlocked). Creation puts the share in the
// session (NetVault, after the save) without the unlock screen, so the panel said "you can sign" and
// the signer never joined the room. One question, asked in one place, by every reader.
const share = { name: 'v', governance: {}, myName: 'a', creatorName: 'a', groupKey: '00', address: '', roster: [], sealedShare: '', createdAt: 0 }

describe('one answer to "is this vault unlocked on this device"', () => {
  it('a share the creation placed in the session counts, with no unlock screen in between', () => {
    const unlockedHere = (session as Record<string, unknown>).unlockedHere as ((id: string) => boolean) | undefined
    expect(unlockedHere, 'session.unlockedHere is the one definition').toBeTypeOf('function')
    session.setUnlockedShare('vault-created-here', share as never)
    expect(unlockedHere!('vault-created-here')).toBe(true)
  })

  it('locking ends it', () => {
    const unlockedHere = (session as Record<string, unknown>).unlockedHere as ((id: string) => boolean) | undefined
    session.setUnlockedShare('vault-locked-again', share as never)
    session.clearUnlockedShare('vault-locked-again')
    expect(unlockedHere?.('vault-locked-again')).toBe(false)
  })

  it('the background signer starts on that answer, not on the unlock screen having run', () => {
    session.setUnlockedShare('vault-created-for-signer', share as never)
    // A creation's share, no unlock screen: the signer runs for this vault while a payment is open.
    expect(signerVault(true, true, { id: 'vault-created-for-signer' }, 3)).toEqual({ id: 'vault-created-for-signer', nonce: 3 })
    expect(signerVault(false, true, { id: 'vault-created-for-signer' }, 3)).toBeNull() // panel closed
    expect(signerVault(true, false, { id: 'vault-created-for-signer' }, 3)).toBeNull() // not a browser vault
    expect(signerVault(true, true, { id: 'vault-not-here' }, 3)).toBeNull() // no share on this device
    const src = codeOf('./VaultSigner.tsx')
    expect(src).toMatch(/const unlocked = signerVault\(!!active, IS_NET, vault, nonce\)/)
    expect(src).not.toMatch(/isVaultUnlocked/)
  })

  it('a passkey opens the read key only: the vault is not unlocked for signing until the passphrase', async () => {
    const r = await unlockWithPasskeyUsing(
      { loadPrfWrap: () => ({}) as never, openPrf: async () => new Uint8Array(32) as never, setReadSecret: () => {}, markVaultUnlocked: () => {} },
      'vault-by-passkey', 'rp', {} as never,
    )
    expect(r).toBe('unlocked')
    expect(session.unlockedHere('vault-by-passkey')).toBe(false)
  })

  it('the vault cards ask the same question', () => {
    expect(codeOf('./screens/Vaults.tsx')).toMatch(/const hasShare = \(id: string\) => unlockedHere\(id\)/)
  })

  it('the signing panel asks the same question', () => {
    expect(codeOf('./screens/SigningPanel.tsx')).toMatch(/const hasShare = unlockedHere\(vault\.id\)|const hasShare = !!vault && unlockedHere\(vault\.id\)/)
  })

  it('after a lock the panel shows the unlock form, not "Connecting", and the signer gets no vault', () => {
    session.setUnlockedShare('vault-then-locked', share as never)
    const base = { started: false, result: false, unlocking: false, ready: false }
    // Unlocked, signer not seated yet: connecting.
    expect(panelConnecting({ ...base, hasShare: session.unlockedHere('vault-then-locked') })).toBe(true)
    session.clearUnlockedShare('vault-then-locked')
    // Locked: not connecting, so the panel falls to its unlock form (`!hasShare`).
    expect(session.unlockedHere('vault-then-locked')).toBe(false)
    expect(panelConnecting({ ...base, hasShare: session.unlockedHere('vault-then-locked') })).toBe(false)
    // And the provider hands the signer no vault: its condition is the same `unlockedHere`.
    expect(signerVault(true, true, { id: 'vault-then-locked' }, 1)).toBeNull()
  })

  it('a passphrase being checked still shows the connecting line', () => {
    expect(panelConnecting({ started: false, result: false, unlocking: true, hasShare: false, ready: false })).toBe(true)
    expect(panelConnecting({ started: true, result: false, unlocking: false, hasShare: true, ready: false })).toBe(false)
  })
})
