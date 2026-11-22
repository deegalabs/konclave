import { describe, it, expect } from 'vitest'
import { codeOf } from './source-scan'

const net = () => codeOf('./screens/NetVault.tsx')

describe('the /net page carries only what its screens need', () => {
  it('the joining screen does not format an invite', () => {
    expect(net()).not.toContain('formatInvite(')
  })

  it('an invite is rendered through the invite card only', () => {
    expect(net()).not.toMatch(/[^=]\{\s*room\s*\}/)
  })

  it('every relay room on the page is the derived one', () => {
    const calls = net().match(/new RelaySession\(/g) ?? []
    expect(calls).toHaveLength(1)
    expect(net()).toContain('new RelaySession(roomId,')
  })

  it('the legacy signing session is gone', () => {
    const src = net()
    for (const gone of ['beginSign', 'signsession', 'signSeatCount', 'newRoomCode', 'signRejoin']) {
      expect(src).not.toContain(gone)
    }
    expect(src).not.toContain('Sign with this vault')
  })

  it('a stray rejoin in a creation room is still consumed', () => {
    const src = net()
    // No branch handles it any more, and the handler ends by consuming whatever is left,
    // so the fixpoint never re-applies it.
    expect(src).not.toContain("'rejoin'")
    expect(src).toMatch(/parsed\.type === 'signed'\s*\)\s*\{\s*return machine\.handle\(parsed, msg\.from\)\s*\}\s*return true/)
  })
})

describe('the page names an invite or a room nowhere but the hidden invite card', () => {
  it('every use of `room` is the state, its invite card, or prose', () => {
    const left = net()
      .replace('const [room, setRoom]', '')
      .replace(/<InviteCard code=\{room\}/g, '')
      .replace(/the room PIN/g, '')
    expect(left.match(/\broom\b/g) ?? []).toHaveLength(0)
  })

  it('both invite cards sit under the creator branch', () => {
    const src = net()
    const at = [...src.matchAll(/<InviteCard code=\{room\}/g)].map((m) => m.index!)
    expect(at).toHaveLength(2)
    for (const i of at) expect(src.slice(Math.max(0, i - 400), i)).toContain("role === 'create'")
  })

  it('the restored-vault note points to the Dashboard, not to a session', async () => {
    const { en } = await import('./i18n/en')
    const { ptBR } = await import('./i18n/pt-BR')
    expect(en['net.persist.restoredNote']).toMatch(/Dashboard/)
    expect(en['net.persist.restoredNote']).not.toMatch(/session/i)
    expect(ptBR['net.persist.restoredNote']).toMatch(/Painel/)
    expect(ptBR['net.persist.restoredNote']).not.toMatch(/sess/i)
  })
})
