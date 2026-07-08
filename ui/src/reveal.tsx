import { createContext, useContext, useState, type ReactNode } from 'react'

// Privacy is a per-device toggle shared across every screen (the "veil"/tarja).
const RevealCtx = createContext<{ revealed: boolean; toggle: () => void }>({
  revealed: false,
  toggle: () => {},
})

export function RevealProvider({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <RevealCtx.Provider value={{ revealed, toggle: () => setRevealed((v) => !v) }}>
      {children}
    </RevealCtx.Provider>
  )
}

export const useReveal = () => useContext(RevealCtx)
