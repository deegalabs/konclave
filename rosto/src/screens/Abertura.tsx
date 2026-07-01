import { Link } from 'react-router-dom'
import { Letterhead } from '../components'

export default function Abertura() {
  return (
    <>
      <Letterhead />
      <div className="abertura">
        <span className="klab">Tesouraria coletiva · privada · à prova de pessoa-única</span>
        <h1 className="hero-title">O cofre que<br />decide em conjunto</h1>
        <div className="vmeta hero-sub">Privado por fora · transparente por dentro</div>
        <div className="abertura-btns">
          <Link className="btn ok block" to="/criar">▸ Criar cofre</Link>
          <Link className="btn block" to="/">Entrar num cofre</Link>
        </div>
        <div className="dim mono hero-hint">começar um grupo · tenho um convite</div>
      </div>
    </>
  )
}
