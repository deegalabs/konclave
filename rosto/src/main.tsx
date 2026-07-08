import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
// Self-hosted fonts — local-first, no external font CDN (weights used by lacre.css).
import '@fontsource/archivo/400.css'
import '@fontsource/archivo/500.css'
import '@fontsource/archivo/600.css'
import '@fontsource/archivo/700.css'
import '@fontsource/archivo/800.css'
import '@fontsource/spline-sans-mono/400.css'
import '@fontsource/spline-sans-mono/500.css'
import '@fontsource/spline-sans-mono/600.css'
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
