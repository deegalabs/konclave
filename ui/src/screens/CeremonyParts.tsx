// The vault-creation screens that are about people rather than machines: handing out the invite,
// comparing the code, and stopping. Kept apart from NetVault so the copy that carries the security
// (the PIN travels apart; each person reads THEIR code first; an unknown name is a stop) is in one
// place.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import encodeQR from '@paulmillr/qr'
import { formatInvite, inviteLink } from '../net'

type Pe = (pt: string, en: string) => string

/** The status line of a step that waits on other people. It stays mounted for the whole step, so a
 *  screen reader hears its text change rather than missing a region that arrived already filled
 *  (a11y audit); it is empty until there is something to wait for. While `busy`, a small spinner
 *  sits beside the sentence so the screen does not look frozen (Daniel, 16/10); the sentence is the
 *  status and the spinner is decorative. */
export function WaitLine({ busy, children }: { busy: boolean; children?: ReactNode }) {
  return (
    <p className="cv-seatlabel cv-wait" role="status">
      {busy && <span className="loader-ring sm" aria-hidden="true" />}
      <span>{children}</span>
    </p>
  )
}

/** What the save step says while others have not saved: how many have, then who is left, so the wait
 *  visibly moves even without motion. One sentence for both creation screens. */
export function saveWaitText(total: number, waiting: string[], pe: Pe): string {
  const saved = Math.max(0, total - waiting.length)
  return pe(
    `${saved} de ${total} guardaram. Esperando: ${waiting.join(', ')}.`,
    `${saved} of ${total} saved. Waiting for: ${waiting.join(', ')}.`,
  )
}

/** Visually the code; to a screen reader, its characters one by one, group by group. */
export function CodeText({ code, label, className }: { code: string; label: string; className?: string }) {
  const groups = code.split('-')
  return (
    <div className={'net-code ' + (className ?? '')}>
      <span aria-hidden="true">{groups.map((g, i) => <span key={i} className="cv-group">{g}{i < groups.length - 1 ? '-' : ''}</span>)}</span>
      <span className="sr-only">{`${label}: ${groups.map((g) => g.split('').join(' ')).join(', ')}`}</span>
    </div>
  )
}

/** Focus a screen's heading when it appears, so the change is announced and focus stays inside. */
function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => { ref.current?.focus() }, [])
  return ref
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** The invite the creator hands out: the code, a link that opens the join screen, its QR, and the
 *  PIN to say on a call. */
export function InviteCard({ code, pin, pe }: { code: string; pin: string; pe: Pe }) {
  const link = inviteLink(code)
  const [status, setStatus] = useState('')
  const [showPin, setShowPin] = useState(false)
  const act = async (what: 'share' | 'link' | 'code') => {
    if (what === 'share' && navigator.share) {
      try { await navigator.share({ url: link }); return } catch { /* cancelled: nothing to say */ return }
    }
    const ok = await copyText(what === 'code' ? code : link)
    setStatus(ok
      ? (what === 'code' ? pe('Código copiado.', 'Code copied.') : pe('Link copiado.', 'Link copied.'))
      : pe('Não deu para copiar aqui. Toque e segure no código para copiar.', 'Could not copy here. Press and hold the code to copy it.'))
    window.setTimeout(() => setStatus(''), 2500)
  }
  return (
    <div className="cv-invite">
      <p className="cv-lead">{pe(
        'Em seguida, vocês vão ler um código curto uns para os outros. Juntem todo mundo numa ligação, ou no mesmo lugar, antes de entrar.',
        'Next, you will all read a short code to each other. Get everyone on one call, or in one room, before they join.')}</p>
      <CodeText code={formatInvite(code)} label={pe('Convite', 'Invite')} className="cv-invite-code" />
      <div className="cv-invite-actions">
        {typeof navigator.share === 'function' && (
          <button type="button" className="net-btn primary" onClick={() => void act('share')}>{pe('Compartilhar convite', 'Share invite')}</button>
        )}
        <button type="button" className={'net-btn' + (typeof navigator.share === 'function' ? '' : ' primary')} onClick={() => void act('link')}>
          {pe('Copiar link do convite', 'Copy invite link')}
        </button>
        <button type="button" className="net-btn" onClick={() => void act('code')}>{pe('Copiar só o código', 'Copy the code only')}</button>
      </div>
      <p className="cv-status" role="status">{status}</p>
      <div className="cv-warn" role="note">
        <strong>{pe('O PIN vai por outro caminho.', 'The PIN goes another way.')}</strong>{' '}
        {pe('Diga o PIN numa ligação, nunca na mesma mensagem do convite.', 'Say the PIN on a call, never in the same message as the invite.')}
        <span className="cv-pin">
          {pe('PIN da sala', 'Room PIN')}: <span className="cv-pin-value">{showPin ? pin : '•'.repeat(Math.max(4, pin.length))}</span>{' '}
          <button type="button" className="cv-linkbtn" aria-pressed={showPin} onClick={() => setShowPin((v) => !v)}>
            {showPin ? pe('ocultar', 'hide') : pe('mostrar', 'show')}
          </button>
        </span>
      </div>
      <div className="cv-invite-qr" role="img" aria-label={pe('QR do link do convite. O PIN não está nele.', 'QR of the invite link. The PIN is not in it.')}
        dangerouslySetInnerHTML={{ __html: encodeQR(link, 'svg') }} />
    </div>
  )
}

/** Confirm unlocks once every other listed person is checked. Pure, so it is tested on its own. */
export function confirmReady(checked: boolean[], mySeat: number): boolean {
  return checked.every((c, i) => c || i + 1 === mySeat)
}

/** The code every member compares with every other before anything secret is sent. Confirm only
 *  unlocks once each other listed person is checked; a difference, a stranger or a missing person
 *  is a stop, not a retry. */
export function CodeCheck({ code, names, vaultName, mySeat, onConfirm, onMismatch, pe }: {
  code: string
  names: string[]
  vaultName?: string
  mySeat: number
  onConfirm: () => void
  onMismatch: () => void
  pe: Pe
}) {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  const [checked, setChecked] = useState<boolean[]>(() => names.map(() => false))
  const ready = confirmReady(checked, mySeat)
  const others = names.length - 1
  const done = checked.filter((c, i) => c && i + 1 !== mySeat).length
  const who = names.map((n, i) => (i + 1 === mySeat ? pe('você', 'you') : n || pe(`pessoa ${i + 1} (sem nome)`, `person ${i + 1} (no name)`))).join(', ')
  return (
    <div className="cv-codecheck">
      <span className="rd-eyebrow">{pe('CONFIRA COM CADA PESSOA', 'CHECK WITH EVERY PERSON')}</span>
      <h2 className="cv-title" tabIndex={-1} ref={heading}>{pe('Confiram o código uns com os outros', 'Check the code with each other')}</h2>
      {vaultName && <p className="cv-headcount">{pe(`Cofre: ${vaultName}`, `Vault: ${vaultName}`)}</p>}
      <p className="cv-headcount">{pe(
        `${names.length} pessoas estão neste cofre: ${who}. É exatamente quem deveria estar aqui?`,
        `${names.length} people are in this vault: ${who}. Is that exactly who should be here?`)}</p>
      <CodeText code={code} label={pe('Código do cofre', 'Vault code')} className="cv-code-big" />
      <p className="cv-lead">{pe(
        'Ligue para cada pessoa da lista. Peça que ela leia o código dela primeiro; não leia o seu antes. Marque o nome só se todos os caracteres baterem. Se você não conhece um nome, não consegue falar com alguém, ou falta alguém que deveria estar, pare: nada foi enviado ainda.',
        'Call each person on the list. Ask them to read their code to you first; do not read yours before they do. Tick their name only if every character matches. If you do not know a name, cannot reach someone, or someone you expected is missing, stop: nothing has been sent yet.')}</p>
      <p className="cv-hint">{pe('Letra pouco clara ao telefone? Diga uma palavra: B de Bola, D de Dado, P de Pato, T de Tatu, M de Mala, N de Navio.', 'Letter unclear on the phone? Say a word: B as in Bravo, D as in Delta, P as in Papa, T as in Tango, M as in Mike, N as in November.')}</p>
      <fieldset className="cv-codecheck-list">
        <legend className="sr-only">{pe('Quem leu para você o mesmo código', 'Who read you the same code')}</legend>
        {names.map((name, i) => {
          if (i + 1 === mySeat) {
            return <div key={i} className="cv-codecheck-row me">{pe(`${name || 'Você'} (este aparelho)`, `${name || 'You'} (this device)`)}</div>
          }
          const id = `cv-check-${i}`
          const twice = !!name && names.filter((x) => x.trim().toLowerCase() === name.trim().toLowerCase()).length > 1
          return (
            <div key={i} className={'cv-codecheck-row' + (name && !twice ? '' : ' unknown')}>
              <input id={id} type="checkbox" checked={checked[i] ?? false} aria-describedby={twice ? `${id}-twice` : undefined}
                onChange={(e) => setChecked((c) => c.map((v, j) => (j === i ? e.target.checked : v)))} />
              <label htmlFor={id}>
                {twice
                  ? pe(`${name} (pessoa ${i + 1}) leu para mim o mesmo código`, `${name} (person ${i + 1}) read me the same code`)
                  : name
                  ? pe(`${name} leu para mim o mesmo código`, `${name} read me the same code`)
                  : pe(`A pessoa ${i + 1} não deu nome: descubra quem é antes de marcar`, `Person ${i + 1} gave no name: find out who it is before ticking`)}
              </label>
              {twice && (
                <span className="cv-govnote" id={`${id}-twice`}>
                  {pe(`Dois membros se chamam ${name}: descubra quem é quem antes de marcar.`, `Two members are called ${name}: find out who is who before ticking.`)}
                </span>
              )}
            </div>
          )
        })}
      </fieldset>
      <p className="cv-seatlabel" id="cv-check-count" role="status">{pe(`${done} de ${others} conferidas`, `${done} of ${others} checked`)}</p>
      <div className="cv-invite-actions">
        <button type="button" className="rd-enter primary cv-primary" disabled={!ready} aria-describedby="cv-check-count" onClick={onConfirm}>
          {pe('Todos leram o mesmo código: criar o cofre', 'Everyone read the same code: create the vault')}
        </button>
        <button type="button" className="cv-stop" onClick={onMismatch}>
          {pe('Um código é diferente ou alguém falta: parar', 'A code differs or someone is missing: stop')}
        </button>
      </div>
    </div>
  )
}

/** What a stopped creation shows: why, and the one thing to do next. */
export function StopPanel({ message, pe }: { message: string; pe: Pe }) {
  const heading = useFocusOnMount<HTMLHeadingElement>()
  return (
    <div className="cv-stopped">
      <h2 className="cv-title" tabIndex={-1} ref={heading}>{pe('Criação do cofre interrompida', 'Vault creation stopped')}</h2>
      <p className="net-error" role="alert">{message}</p>
      <button type="button" className="rd-enter primary cv-primary" onClick={() => window.location.reload()}>
        {pe('Começar de novo', 'Start again')}
      </button>
    </div>
  )
}
