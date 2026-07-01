import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import './lacre.css'
import App from './App.tsx'
import { RevealProvider } from './reveal'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RevealProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </RevealProvider>
  </StrictMode>,
)
