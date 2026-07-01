import { Routes, Route } from 'react-router-dom'
import { useReveal } from './reveal'
import Painel from './screens/Painel'
import Abertura from './screens/Abertura'
import Cerimonia from './screens/Cerimonia'
import NovoPagamento from './screens/NovoPagamento'
import NovaFolha from './screens/NovaFolha'
import Proposta from './screens/Proposta'
import Enviado from './screens/Enviado'
import Razao from './screens/Razao'
import './App.css'

export default function App() {
  const { revealed } = useReveal()
  return (
    <div className={'sheet' + (revealed ? ' revealed' : '')}>
      <Routes>
        <Route path="/" element={<Painel />} />
        <Route path="/abertura" element={<Abertura />} />
        <Route path="/criar" element={<Cerimonia />} />
        <Route path="/pagar" element={<NovoPagamento />} />
        <Route path="/folha" element={<NovaFolha />} />
        <Route path="/proposta" element={<Proposta />} />
        <Route path="/enviado" element={<Enviado />} />
        <Route path="/razao" element={<Razao />} />
      </Routes>
    </div>
  )
}
