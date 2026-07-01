import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Letterhead, Stepper } from '../components'

export default function Cerimonia() {
  const [step, setStep] = useState(1)
  const nav = useNavigate()
  return (
    <>
      <Letterhead right={<Stepper step={step} />} />
      <div className="page">
        {step === 1 && (
          <>
            <h1 className="h1">Criar cofre</h1>
            <label className="field"><span>Nome do cofre</span>
              <input className="input" defaultValue="Tesouraria da comunidade" />
            </label>
            <div className="field"><span>Quantas pessoas precisam aprovar cada pagamento?</span>
              <div className="selq"><span className="box">2</span> de <span className="box">3</span> <span className="dim selq-unit">membros</span></div>
              <div className="hint">↳ Nenhum pagamento sai sem 2 aprovações. Ninguém sozinho controla o dinheiro.</div>
            </div>
            <hr className="rule" />
            <div className="right"><button className="btn ok" onClick={() => setStep(2)}>▸ Avançar</button></div>
          </>
        )}

        {step === 2 && (
          <>
            <span className="klab">Envie este convite para cada pessoa</span>
            <div className="row-gap">
              <input className="input mono" defaultValue="konclave://convite/9f2e…a71" readOnly />
              <button className="btn ghost">Copiar</button><button className="btn ghost">QR</button>
            </div>
            <span className="klab">Membros · aguardando 2 de 3 entrarem</span>
            <div className="members">
              <div className="memberrow"><span>Você <span className="dim">(dona)</span></span><span className="tag ok">pronta</span></div>
              <div className="memberrow"><span>Bruno</span><span className="tag ok">entrou</span></div>
              <div className="memberrow"><span>Carla</span><span className="tag">aguardando…</span></div>
            </div>
            <hr className="rule" />
            <div className="confirm">⚠ Todos precisam estar no app agora — a criação acontece uma vez, em conjunto.</div>
            <div className="right mt"><button className="btn ok" onClick={() => setStep(3)}>▸ Criar cofre agora</button></div>
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="h1">Gerando as chaves…</h1>
            <div className="vmeta">Isto acontece uma vez. Sua parte da chave fica só neste aparelho — nunca sai daqui.</div>
            <div className="progress-bar"><span /></div>
            <div className="right mt"><button className="btn ok" onClick={() => setStep(4)}>▸ Concluir</button></div>
          </>
        )}

        {step === 4 && (
          <>
            <h1 className="h1 pine">✓ Cofre pronto</h1>
            <div className="vmeta">Sua parte da chave foi guardada com segurança neste aparelho. Ela nunca sai daqui.</div>
            <span className="klab mt">Endereço para receber ZEC</span>
            <div className="row-gap">
              <input className="input mono" defaultValue="u1vjgxlvz4ewnt43rkq6fzexpl…d406dr" readOnly />
              <button className="btn ghost">Copiar</button><button className="btn ghost">QR</button>
            </div>
            <div className="hint warn">⚠ Receba apenas em endereço Orchard.</div>
            <hr className="rule" />
            <div className="right"><button className="btn ok" onClick={() => nav('/')}>▸ Ir ao painel</button></div>
          </>
        )}
      </div>
    </>
  )
}
