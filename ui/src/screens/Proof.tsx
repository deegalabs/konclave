import { Letterhead } from '../components'
import { useI18n } from '../i18n'
import { useToast } from '../toast'
import { PROOF_RECORD_URL, PROOF_TXS, proofOriginCounts } from '../proof-record'
import '../proof.css'

// Judge-facing proof page: the browser equivalent of scripts/verify-proof.mjs. It shows each txid
// of the record with explorer links anyone can open, and states plainly what on-chain data can and
// cannot prove (mirrors docs/PROOF.md).
// Everything is client-side. The honest scope note is load-bearing: the chain proves the txs
// are real, mined and shielded, but a FROST-aggregated Orchard signature is indistinguishable
// on-chain from a single-signer one, so the threshold nature is attested off-chain (code + ceremony).
//
// NO IN-PAGE CHECK. This screen used to offer "verify on-chain now", a fetch to Blockchair's API.
// The site's Content-Security-Policy (ui/vercel.json, and the desktop's) admits no such origin, so
// the browser refused the request before it left, and a check that cannot run reads as a broken
// claim (#615). Until a policy admits an explorer, the page offers only what works everywhere: the
// explorer links, and the script. A test pins this file's fetch origins to the policy.
//
// THE LIST IS NOT KEPT HERE. It lived in this file as an array of eight, and this comment said
// "eight", while docs/PROOF.md grew to nineteen. It is `../proof-record` now, which a test holds to
// the table in docs/PROOF.md, and no count is written on this screen or in its comments.

type Locale = 'pt-BR' | 'en'

const explorerZec = (txid: string) => `https://mainnet.zcashexplorer.app/transactions/${txid}`
const explorerBlockchair = (txid: string) => `https://blockchair.com/zcash/transaction/${txid}`

const TXT = {
  'pt-BR': {
    eyebrow: 'Konclave · Prova',
    title: 'Confira nossa prova de mainnet',
    lead: 'Transações reais na mainnet do Zcash. Confira você mesmo, por exploradores públicos independentes. Nada aqui pede confiança cega.',
    txidLabel: 'ID da transação',
    blockLabel: 'Bloco',
    copy: 'Copiar',
    copied: 'Copiado',
    openZec: 'Abrir no zcashexplorer',
    openBlockchair: 'Abrir no Blockchair',
    howTitle: 'Como conferir',
    how:
      'Abra cada transação nos links de explorador abaixo, em dois exploradores independentes. Para conferir a lista inteira de uma vez, fora do navegador, rode `node scripts/verify-proof.mjs` no repositório.',
    scopeTitle: 'O que esta prova mostra (e o que não mostra)',
    scopeCan:
      'Os dados on-chain provam que a transação existe, foi minerada em um bloco e é blindada (Orchard, ou o pool Ironwood desde o NU6.3). Não revela valores nem partes, e essa ausência de detalhe é a privacidade funcionando.',
    scopeCannot:
      'Os dados on-chain NÃO provam, sozinhos, a natureza de limiar (t-de-n) do FROST. Uma assinatura Orchard agregada por FROST é indistinguível de uma assinatura de signatário único na cadeia, e essa indistinguibilidade é justamente a propriedade de privacidade. A natureza de limiar é atestada pelo código e pela cerimônia, fora da cadeia.',
    originDealer: 'Cofre dividido por um trusted dealer (a chave existiu inteira na criação)',
    originDkg: 'Cofre criado por DKG (a chave nunca existiu inteira)',
    scopeOrigin:
      'Como a chave de cada cofre foi feita também é algo que a cadeia não mostra. Das transações acima, {dealer} vieram de cofres divididos por um trusted dealer, em que a chave inteira existiu numa máquina na criação, e {dkg} vieram de cofres criados por DKG, em que a chave nunca existiu inteira. Cada cartão diz qual.',
    scopeRecord:
      'Esta lista é uma cópia da tabela em docs/PROOF.md, que é o registro. O registro diz, linha a linha, o que se apoia no bloco e o que se apoia na palavra de quem executou.',
    recordLink: 'Abrir o registro (docs/PROOF.md)',
  },
  en: {
    eyebrow: 'Konclave · Proof',
    title: 'Verify our mainnet proof yourself',
    lead: 'Real transactions on the Zcash mainnet. Confirm them yourself, through independent public explorers. Nothing here asks you to take it on faith.',
    txidLabel: 'Transaction ID',
    blockLabel: 'Block',
    copy: 'Copy',
    copied: 'Copied',
    openZec: 'Open on zcashexplorer',
    openBlockchair: 'Open on Blockchair',
    howTitle: 'How to check',
    how:
      'Open each transaction through the explorer links below, on two independent explorers. To check the whole list at once, outside the browser, run `node scripts/verify-proof.mjs` in the repository.',
    scopeTitle: 'What this proof shows (and what it does not)',
    scopeCan:
      'On-chain data proves the transaction exists, is mined in a block, and is shielded (Orchard, or the Ironwood pool since NU6.3). It reveals nothing about amounts or parties, and that absence of detail is the privacy working as intended.',
    scopeCannot:
      'On-chain data does NOT, by itself, prove the threshold (t-of-n) FROST nature. A FROST-aggregated Orchard signature is indistinguishable on-chain from a single-signer one, and that indistinguishability is precisely the privacy property. The threshold nature is attested by the code and the ceremony, off-chain.',
    originDealer: 'Vault split by a trusted dealer (the whole key existed at creation)',
    originDkg: 'Vault created by DKG (the key was never whole)',
    scopeOrigin:
      'How the key of each vault was made is also something the chain cannot show. Of the transactions above, {dealer} came from vaults split by a trusted dealer, where the whole key existed on one machine at creation, and {dkg} came from vaults created by DKG, where the key was never whole. Each card says which.',
    scopeRecord:
      'This list is a copy of the table in docs/PROOF.md, which is the record. The record says, row by row, what rests on the block and what rests on the word of whoever ran it.',
    recordLink: 'Open the record (docs/PROOF.md)',
  },
}

// Rich text: renders `code` spans inside a plain string (used for the "how to check" note).
function rich(s: string) {
  return s.split(/(`[^`]+`)/g).map((p, i) =>
    p.startsWith('`') && p.endsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : <span key={i}>{p}</span>,
  )
}

export default function Proof() {
  const { locale } = useI18n()
  const toast = useToast()
  const loc = (locale as Locale) in TXT ? (locale as Locale) : 'en'
  const T = TXT[loc]

  const origins = proofOriginCounts()
  const scopeOrigin = T.scopeOrigin
    .replace('{dealer}', String(origins.dealer))
    .replace('{dkg}', String(origins.dkg))

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)
    toast.ok(T.copied)
  }

  return (
    <div className="proof">
      <Letterhead />
      <main className="proof-main">
        <article className="proof-col">
          <span className="proof-eyebrow">{T.eyebrow}</span>
          <h1 className="proof-title">{T.title}</h1>
          <p className="proof-lead">{T.lead}</p>

          <aside className="proof-fallback">
            <span className="proof-fallback-title">{T.howTitle}</span>
            <p>{rich(T.how)}</p>
          </aside>

          <div className="proof-cards">
            {PROOF_TXS.map((t) => {
              return (
                <section className="proof-card" key={t.txid}>
                  <p className="proof-card-label">{t.label[loc]}</p>

                  <span className="proof-field-label">{T.txidLabel}</span>
                  <div className="proof-txid-row">
                    <code className="proof-txid">{t.txid}</code>
                    <button
                      type="button"
                      className="proof-copy"
                      onClick={() => copy(t.txid)}
                      aria-label={T.copy}
                    >
                      {T.copy}
                    </button>
                  </div>

                  <div className="proof-meta">
                    <span className="proof-block">
                      {T.blockLabel} <strong>{t.block.toLocaleString(loc === 'pt-BR' ? 'pt-BR' : 'en-US')}</strong>
                    </span>
                    <span className="proof-block">{t.origin === 'dealer' ? T.originDealer : T.originDkg}</span>
                  </div>

                  <div className="proof-links">
                    <a className="proof-link" href={explorerZec(t.txid)} target="_blank" rel="noreferrer noopener">
                      {T.openZec}
                    </a>
                    <a
                      className="proof-link"
                      href={explorerBlockchair(t.txid)}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {T.openBlockchair}
                    </a>
                  </div>
                </section>
              )
            })}
          </div>

          <section className="proof-scope" aria-label={T.scopeTitle}>
            <h2 className="proof-scope-title">{T.scopeTitle}</h2>
            <p className="proof-scope-can">{T.scopeCan}</p>
            <p className="proof-scope-cannot">{T.scopeCannot}</p>
            <p className="proof-scope-can">{scopeOrigin}</p>
            <p className="proof-scope-can">{T.scopeRecord}</p>
            <div className="proof-links">
              <a className="proof-link" href={PROOF_RECORD_URL} target="_blank" rel="noreferrer noopener">
                {T.recordLink}
              </a>
            </div>
          </section>
        </article>
      </main>
    </div>
  )
}
