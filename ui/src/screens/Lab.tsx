import { Link } from 'react-router-dom'
import { Letterhead } from '../components'
import { useI18n } from '../i18n'
import '../redesign.css'
import '../landing.css'

/**
 * /lab — the laboratory hub (redesign Fase 0). Groups the live cryptographic proofs that used
 * to be scattered top-level routes (signer, recovery, inheritance) plus the on-chain proof, so
 * they read as one "see the cryptography" surface instead of disconnected pages. Standalone
 * (no rail), reuses the landing's explore-grid styling. Bilingual inline.
 */
const COPY: Record<'pt-BR' | 'en', {
  eyebrow: string; title: string; lead: string; back: string
  items: { to: string; name: string; desc: string; tag?: string }[]
}> = {
  'pt-BR': {
    eyebrow: 'LABORATÓRIO',
    title: 'Veja a criptografia acontecer',
    lead: 'Provas ao vivo, isoladas do produto: a assinatura de quórum, a recuperação e a herança rodando de verdade, além das transações reais na blockchain. Nada aqui é o cofre do dia a dia; é o motor exposto.',
    back: '← Voltar',
    items: [
      { to: '/signer', name: 'Assinar no navegador', desc: 'Uma assinatura de quórum acontecendo inteira dentro do navegador.', tag: 'demo' },
      { to: '/recovery', name: 'Recuperação de membro', desc: 'Um quórum reconstrói a parte de quem perdeu acesso, sem expor a chave.', tag: 'demo' },
      { to: '/inheritance', name: 'Herança', desc: 'Se um responsável some, o quórum libera os fundos a um herdeiro.', tag: 'demo' },
      { to: '/lab/background-signer', name: 'Assinatura em 2º plano', desc: 'Um cofre destrancado assina um pagamento em 2º plano, sem ir ao /net (Stage 3).', tag: 'demo' },
      { to: '/proof', name: 'Comprovação na blockchain', desc: 'Confira você mesmo, no explorador público, as transações reais na mainnet.', tag: 'prova' },
    ],
  },
  en: {
    eyebrow: 'LABORATORY',
    title: 'Watch the cryptography happen',
    lead: 'Live proofs, isolated from the product: the quorum signature, recovery and inheritance running for real, plus the real on-chain transactions. None of this is the everyday vault; it is the engine on display.',
    back: '← Back',
    items: [
      { to: '/signer', name: 'Sign in the browser', desc: 'A quorum signature happening entirely inside the browser.', tag: 'demo' },
      { to: '/recovery', name: 'Member recovery', desc: 'A quorum rebuilds the share of whoever lost access, without exposing the key.', tag: 'demo' },
      { to: '/inheritance', name: 'Inheritance', desc: 'If a steward disappears, the quorum releases the funds to an heir.', tag: 'demo' },
      { to: '/lab/background-signer', name: 'Background signing', desc: 'An unlocked vault signs a payment in the background, no /net screen (Stage 3).', tag: 'demo' },
      { to: '/proof', name: 'Proof on the blockchain', desc: 'Check for yourself, on the public explorer, the real mainnet transactions.', tag: 'proof' },
    ],
  },
}

export default function Lab() {
  const { locale } = useI18n()
  const c = COPY[locale === 'pt-BR' ? 'pt-BR' : 'en']
  return (
    <div className="rd lp">
      <div className="lp-wrap">
        <Letterhead right={<Link to="/" className="doclink">{c.back}</Link>} />
      </div>
      <section className="lp-section" style={{ paddingTop: 8 }}>
        <div className="lp-wrap">
          <span className="eyebrow sec-eyebrow">{c.eyebrow}</span>
          <h2 className="lp-title">{c.title}</h2>
          <p className="sub" style={{ maxWidth: '62ch' }}>{c.lead}</p>
          <div className="lp-explore-grid" style={{ marginTop: 22 }}>
            {c.items.map((it) => (
              <Link key={it.to} to={it.to} className="lp-explore-card">
                <span className="lp-ex-head">
                  <span className="lp-ex-name">{it.name}</span>
                  {it.tag && <span className="lp-ex-tag">{it.tag}</span>}
                </span>
                <span className="lp-ex-desc">{it.desc}</span>
                <span className="lp-ex-go" aria-hidden="true">→</span>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
