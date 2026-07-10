import { Routes, Route } from 'react-router-dom'
import { useReveal } from './reveal'
import Layout from './Layout'
import Demo from './screens/Demo'
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
import './App.css'

export default function App() {
  const { revealed } = useReveal()
  return (
    <div className={'root' + (revealed ? ' revealed' : '')}>
      <Routes>
        {/* Onboarding — standalone, no rail */}
        <Route path="/" element={<Vaults />} />
        <Route path="/vaults" element={<Vaults />} />
        <Route path="/intro" element={<Intro />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="/create" element={<Ceremony />} />
        {/* In-vault — persistent left rail */}
        <Route element={<Layout />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/pay" element={<NewPayment />} />
          <Route path="/payroll" element={<NewPayroll />} />
          <Route path="/proposal" element={<Proposal />} />
          <Route path="/proposals" element={<Proposals />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="/members" element={<Members />} />
          <Route path="/people" element={<People />} />
        </Route>
      </Routes>
    </div>
  )
}
