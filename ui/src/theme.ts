/** Theme selection (white-first). Light is the default; dark is an explicit opt-in via
 *  `[data-theme="dark"]` on <html> (see lacre.css). Persisted per device. The product leads
 *  with white for everyone, so there is no prefers-color-scheme auto-switch — the choice is
 *  the user's, in Settings. */
export type Theme = 'light' | 'dark'
const KEY = 'konclave.theme'

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function applyTheme(t: Theme): void {
  const root = document.documentElement
  if (t === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
}

export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* storage unavailable — theme still applies for this session */
  }
  applyTheme(t)
}
