import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Mark } from '../components'
import '../redesign.css'

/** The logo lockup with a graceful fallback to the SVG mark. */
function IntroLogo() {
  const [failed, setFailed] = useState(false)
  if (failed) return <Mark />
  return (
    <img className="rd-lockup intro-logo" src={`${import.meta.env.BASE_URL}logo.png`} alt="Konclave"
      onError={() => setFailed(true)} />
  )
}

const CARDS: Array<{ ic: string; t: string; d: string }> = [
  { ic: '🖥️', t: 'Roda no seu aparelho', d: 'Local-first: seus dados e a sua parte da chave ficam só aqui. Não há servidor na internet guardando nada.' },
  { ic: '🤝', t: 'Decidido em conjunto', d: 'Um cofre tem um quórum (ex.: 2 de 3). Nenhum pagamento sai sem as aprovações combinadas — ninguém move o dinheiro sozinho.' },
  { ic: '🛡️', t: 'Privado por fora, transparente por dentro', d: 'Pagamentos blindados na rede Zcash (Orchard); dentro do grupo, quem propôs e quem aprovou fica registrado.' },
]

export default function Intro() {
  return (
    <div className="rd">
      <div className="rd-shell intro">
        <div className="intro-hero">
          <IntroLogo />
          <span className="rd-eyebrow">O cofre que decide em conjunto</span>
          <h1>Um fundo coletivo que<br />ninguém move sozinho.</h1>
          <p>
            O <b>Konclave</b> deixa um grupo cuidar de um fundo <b>junto</b> — criar o cofre,
            aprovar pagamentos por quórum e fazer uma folha privada — sem CLI, sem copiar hex,
            sem confiar em uma pessoa só.
          </p>
        </div>

        <div className="intro-cards">
          {CARDS.map((c) => (
            <div className="intro-card" key={c.t}>
              <div className="intro-ic">{c.ic}</div>
              <div className="intro-t">{c.t}</div>
              <div className="intro-d">{c.d}</div>
            </div>
          ))}
        </div>

        <div className="intro-cta">
          <Link className="rd-enter primary" to="/">Ver meus cofres <span className="arw">→</span></Link>
        </div>

        <div className="rd-note">
          🔑 A criptografia é feita pelas ferramentas oficiais da <b>Zcash Foundation</b> (FROST/Orchard).
          O Konclave é a camada humana por cima — a usabilidade, não a cripto.
        </div>
      </div>
    </div>
  )
}
