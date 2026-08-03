import { Routes, Route, Navigate } from 'react-router-dom'
import { isDesktop } from './platform'
import { useReveal } from './reveal'
import { DemoBanner } from './components'
import Layout from './Layout'
import Demo from './screens/Demo'
import WasmSigner from './screens/WasmSigner'
import NetVault from './screens/NetVault'
import Dashboard from './screens/Dashboard'
import Intro from './screens/Intro'
import Ceremony from './screens/Ceremony'
import NewPayment from './screens/NewPayment'
import NewPayroll from './screens/NewPayroll'
import Proposal from './screens/Proposal'
import Proposals from './screens/Proposals'
import Ledger from './screens/Ledger'
import Members from './screens/Members'
import People from './screens/People'
import Vaults from './screens/Vaults'
import Receive from './screens/Receive'
import Docs from './screens/Docs'
import Proof from './screens/Proof'
import Recovery from './screens/Recovery'
import Inheritance from './screens/Inheritance'
import Settings from './screens/Settings'
import Ceremonies from './screens/Ceremonies'
import Lab from './screens/Lab'
import BackgroundSignerLab from './screens/BackgroundSignerLab'
import './App.css'

export default function App() {
  const { revealed } = useReveal()
  return (
    <div className={'root' + (revealed ? ' revealed' : '')}>
      <DemoBanner />
      <Routes>
        {/* Onboarding — standalone, no rail */}
        {/* The desktop app opens straight on the product (the vaults), not the marketing landing;
            the web keeps the landing at `/`. */}
        <Route path="/" element={isDesktop ? <Navigate to="/vaults" replace /> : <Intro />} />
        <Route path="/vaults" element={<Vaults />} />
        <Route path="/intro" element={<Intro />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="/signer" element={<WasmSigner />} />
        <Route path="/net" element={<NetVault />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/docs/:section" element={<Docs />} />
        <Route path="/proof" element={<Proof />} />
        <Route path="/lab" element={<Lab />} />
        <Route path="/lab/background-signer" element={<BackgroundSignerLab />} />
        <Route path="/recovery" element={<Recovery />} />
        <Route path="/inheritance" element={<Inheritance />} />
        <Route path="/create" element={<Ceremony />} />
        {/* In-vault — persistent left rail */}
        <Route element={<Layout />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/receive" element={<Receive />} />
          <Route path="/pay" element={<NewPayment />} />
          <Route path="/payroll" element={<NewPayroll />} />
          <Route path="/proposal" element={<Proposal />} />
          <Route path="/proposals" element={<Proposals />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="/ceremonies" element={<Ceremonies />} />
          <Route path="/members" element={<Members />} />
          <Route path="/people" element={<People />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
    </div>
  )
}
