// What the device the room names as sender checks before asking the coordinator to send, and what
// every open panel watches until the payment goes out (#626 review).
//
// The room names one sender per window (`tallyAfter`), but after that window a new completion may
// name another: that is how a payment whose named sender vanished gets sent (#334). If the first
// sender did send, a second request would wait for the coordinator's lock and be refused as not
// ready, and the panel used to report that as a failed send and withdraw every signature, over a
// payment that had gone out (#280). So the coordinator's record of the payment is the last word:
// checked before the request, and read again when the coordinator refuses because it was sent.
import { readOutcome, type PanelResult, type ReplyEnd, type Resolution, type SentProbe } from './send-outcome'
import { startVisiblePoll } from './usePoll'
import type { TFn } from './i18n'
import { humanError, netState } from './api'

/** The txid of the payment if the coordinator records it as sent, or null. The rule that reads a
 *  send's outcome (`readOutcome`), so the check, the watch and the resolution of a lost reply agree.
 *  A list that could not be read says nothing either way, and the send goes ahead: the coordinator
 *  refuses it if it is not ready. */
export function alreadySent(list: ReadonlyArray<SentProbe> | null, id: string): string | null {
  const r = readOutcome(list, id)
  return r?.kind === 'sent' ? r.txid : null
}

/** Watch the payment's record until the coordinator has it sent, and say so (`onSent`). Every open
 *  panel runs one, so it is light: at most one read in flight, and none while the tab is hidden.
 *  The coordinator holds the vault's lock for the whole of a send, and every read that names the
 *  vault waits on it holding one of the coordinator's workers; a read every few seconds from every
 *  open panel, each one left waiting, emptied the pool within minutes (#626 review, round 3; the
 *  shape of the 2026-08-27 incident). COORD-LOCK phase 1 lets reads stop waiting on that lock (a busy
 *  vault answers 503 at once); the watch stays light anyway, since every panel runs one. Returns the
 *  function that stops it. */
export function watchSent(
  list: () => Promise<ReadonlyArray<SentProbe> | null>,
  id: string,
  onSent: (txid: string) => void,
  everyMs = 4000,
  doc?: Parameters<typeof startVisiblePoll>[2],
  win?: Parameters<typeof startVisiblePoll>[3],
): () => void {
  let busy = false
  let on = true
  const stop = startVisiblePoll(() => {
    if (busy) return
    busy = true
    void list()
      .then((l) => {
        const txid = alreadySent(l, id)
        if (on && txid) onSent(txid)
      })
      .catch(() => { /* an unreadable list says nothing; the next tick asks again */ })
      .finally(() => { busy = false })
  }, everyMs, doc, win)
  return () => {
    on = false
    stop()
  }
}

/** States in which the coordinator will not send the payment again, by the names the dictionaries
 *  have (`netState`). */
const ENDED = new Set(['expired', 'rejected', 'cancelled', 'superseded'])

/** The sentence for a send the coordinator refused because the payment is not ready, from the state
 *  it named. A payment that lost an approval may become sendable again; a state the screen does
 *  not know is not printed. */
export function notSendableText(t: TFn, state: string): string {
  const s = netState(state)
  if (s === 'awaiting') return t('signing.errNotSendablePending')
  if (ENDED.has(s)) return t('signing.errNoLongerSendable', { state: t('state.' + s) })
  return t('signing.errNotSendable')
}

/** What the signing panel does with a send's ending (`readReply`): show it sent, ask the record,
 *  say it is unknown (the money may have moved: no withdrawal, no Try again), or fail (nothing went
 *  out: withdraw and offer Try again). One place, tested, so the panel cannot route an ending that may
 *  have paid into a failure. */
export type PanelStep =
  | { do: 'sent'; txid: string }
  | { do: 'resolve' }
  | { do: 'unknown'; why: 'lost' | 'held' | 'broadcast'; txid?: string }
  | { do: 'fail'; text: string; raw?: string }

/** A step the panel shows: every one but `resolve`, which asks the record first. */
export type ShownStep = Exclude<PanelStep, { do: 'resolve' }>

export function panelStep(end: ReplyEnd, t: TFn): PanelStep {
  switch (end.kind) {
    case 'sent': return { do: 'sent', txid: end.txid }
    case 'resolve': return { do: 'resolve' }
    case 'held': return end.txid ? { do: 'unknown', why: 'broadcast', txid: end.txid } : { do: 'unknown', why: 'held' }
  }
  if (end.why === 'unreachable') return { do: 'fail', text: t('signing.errUnreachable') }
  if (end.why === 'no-txid') return { do: 'fail', text: t('signing.errNoTxid') } // a reply with no txid is NOT a send
  if (end.why === 'not-sendable') return { do: 'fail', text: notSendableText(t, end.state), raw: end.raw }
  // Through humanError, so the money path never shows a binary path and a Rust struct.
  return { do: 'fail', text: humanError(t, end.raw), raw: end.raw }
}

/** What the panel does once the record has answered about a lost reply: sent, or unknown. Never a
 *  failure, which would withdraw and offer Try again over a payment that may be on the network (#280). */
export function resolvedStep(r: Resolution): ShownStep {
  return r.kind === 'sent' ? { do: 'sent', txid: r.txid } : { do: 'unknown', why: 'lost' }
}

/** The note under "we do not know whether this payment went out", by why it is not known. */
export function unresolvedNoteKey(why: 'lost' | 'held' | 'broadcast'): string {
  return why === 'held' ? 'signing.heldNote' : why === 'broadcast' ? 'signing.broadcastNote' : 'signing.unresolvedNote'
}

/** What the panel shows for a step that is not `resolve` (the caller asks the record for that one). */
export function stepResult(step: ShownStep): PanelResult {
  if (step.do === 'sent') return { txid: step.txid }
  if (step.do === 'fail') return { error: step.text }
  return { unresolved: step.why, ...(step.txid ? { txid: step.txid } : {}) }
}

/** What `/net` says for a send's ending, in both languages, and whether it stops there (`stop`: the
 *  send went nowhere, so the list is not reloaded). Only a send that went nowhere is "failed"; one
 *  that may be on the network, or that another device sent, never is (#280). */
export function netReplyText(end: ReplyEnd): { pt: string; en: string; stop: boolean } {
  if (end.kind === 'sent') return { pt: `Transmitido. txid: ${end.txid}`, en: `Broadcast. txid: ${end.txid}`, stop: false }
  if (end.kind === 'held') {
    const tx = end.txid ? ` (txid ${end.txid})` : ''
    return {
      pt: `O coordenador tem uma tentativa de envio deste pagamento que pode estar na rede${tx}. Não tente de novo: confira a proposta na lista.`,
      en: `The coordinator has an attempt to send this payment that may be on the network${tx}. Do not retry: check the proposal in the list.`,
      stop: false,
    }
  }
  if (end.kind === 'resolve' && end.sentElsewhere) {
    return { pt: 'Outro aparelho já enviou este pagamento: veja a proposta na lista.', en: 'Another device already sent this payment: see the proposal in the list.', stop: false }
  }
  if (end.kind === 'resolve') {
    return {
      pt: 'Sem resposta do cofre. O pagamento PODE ter sido transmitido - confira a proposta na lista antes de tentar de novo.',
      en: 'No answer from the vault. The payment MAY have been broadcast - check the proposal in the list before retrying.',
      stop: false,
    }
  }
  if (end.why === 'unreachable') return { pt: 'Falha ao executar: não foi possível falar com o coordenador.', en: 'Execute failed: could not reach the coordinator.', stop: true }
  if (end.why === 'no-txid') return { pt: 'Falha ao executar: o coordenador respondeu sem txid.', en: 'Execute failed: the coordinator replied with no txid.', stop: true }
  const raw = end.why === 'not-sendable' ? `${end.raw} (${end.state})` : end.raw
  return { pt: `Falha ao executar: ${raw}`, en: `Execute failed: ${raw}`, stop: true }
}
