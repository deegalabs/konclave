import { createRoot } from 'react-dom/client'
// Self-hosted fonts - local-first, no external font CDN (weights used by lacre.css).
import '@fontsource/archivo/400.css'
import '@fontsource/archivo/500.css'
import '@fontsource/archivo/600.css'
import '@fontsource/archivo/700.css'
import '@fontsource/archivo/800.css'
import '@fontsource/spline-sans-mono/400.css'
import '@fontsource/spline-sans-mono/500.css'
import '@fontsource/spline-sans-mono/600.css'
import './lacre.css'
import { Root } from './Root'
import { applyTheme, getTheme } from './theme'
import { isDesktop } from './platform'
import { retireServiceWorkers } from './desktop-worker'

// Apply the saved theme before first paint (white-first; dark is opt-in via Settings).
applyTheme(getTheme())

createRoot(document.getElementById('root')!).render(<Root />)

// On the web, PWA registration + update lifecycle are owned by <UpdatePrompt /> (useRegisterSW),
// rendered in the app tree. The desktop app renders no <UpdatePrompt /> and removes any worker an
// earlier version left in the WebView profile (desktop-worker.ts).
if (isDesktop) void retireServiceWorkers()
