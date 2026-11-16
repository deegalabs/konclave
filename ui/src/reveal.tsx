import { createContext, useContext, useState, type ReactNode } from 'react'

// Privacy is a per-device toggle shared across every screen (the "veil"/tarja).
const RevealCtx = createContext<{ revealed: boolean; toggle: () => void }>({
  revealed: false,
  toggle: () => {},
})

/** `initial` is for tests that read a figure: every real load starts hidden. */
export function RevealProvider({ children, initial = false }: { children: ReactNode; initial?: boolean }) {
  const [revealed, setRevealed] = useState(initial)
  return (
    <RevealCtx.Provider value={{ revealed, toggle: () => setRevealed((v) => !v) }}>
      {children}
    </RevealCtx.Provider>
  )
}

export const useReveal = () => useContext(RevealCtx)
