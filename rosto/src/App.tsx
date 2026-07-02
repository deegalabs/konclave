import { Routes, Route } from 'react-router-dom'
import { useReveal } from './reveal'
import Painel from './screens/Painel'
import Abertura from './screens/Abertura'
import Cerimonia from './screens/Cerimonia'
import NovoPagamento from './screens/NovoPagamento'
import NovaFolha from './screens/NovaFolha'
import Proposta from './screens/Proposta'
import Propostas from './screens/Propostas'
import Razao from './screens/Razao'
import Membros from './screens/Membros'
import Beneficiarios from './screens/Beneficiarios'
import Cofres from './screens/Cofres'
import './App.css'

export default function App() {
  const { revealed } = useReveal()
  return (
    <div className={'sheet' + (revealed ? ' revealed' : '')}>
      <Routes>
        <Route path="/" element={<Cofres />} />
        <Route path="/painel" element={<Painel />} />
        <Route path="/cofres" element={<Cofres />} />
        <Route path="/abertura" element={<Abertura />} />
        <Route path="/criar" element={<Cerimonia />} />
        <Route path="/pagar" element={<NovoPagamento />} />
        <Route path="/folha" element={<NovaFolha />} />
        <Route path="/proposta" element={<Proposta />} />
        <Route path="/propostas" element={<Propostas />} />
        <Route path="/razao" element={<Razao />} />
        <Route path="/membros" element={<Membros />} />
        <Route path="/beneficiarios" element={<Beneficiarios />} />
      </Routes>
    </div>
  )
}
