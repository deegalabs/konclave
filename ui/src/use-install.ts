// The browser side of the install offer. The decision lives in `install.ts` and is pure; this only
// gathers the three observations it needs and holds the one event the browser gives us.

import { useCallback, useEffect, useState } from 'react'
import { installOffer, isIos, isStandalone, type InstallOffer, type InstallPromptEvent } from './install'

export function useInstall(): { offer: InstallOffer; promptInstall: () => Promise<void> } {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null)
  // `navigator.standalone` is Safari's own flag and is absent from the DOM types, so the two
  // observations are handed over explicitly rather than passing the whole Window and casting it.
  const [installed, setInstalled] = useState(() => isStandalone({
    matchMedia: (q) => window.matchMedia(q),
    navigator: window.navigator as { standalone?: boolean },
  }))

  useEffect(() => {
    // Chromium fires this once and, if nobody calls preventDefault, forgets it. Keeping the event
    // is the whole trick: `prompt()` may only be called later, from a real user gesture.
    const onBefore = (e: Event) => {
      e.preventDefault()
      setDeferred(e as InstallPromptEvent)
    }
    // Fires when the install completes, including from the browser's own menu - so the offer
    // disappears without needing a reload.
    const onInstalled = () => {
      setDeferred(null)
      setInstalled(true)
    }
    window.addEventListener('beforeinstallprompt', onBefore)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBefore)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const promptInstall = useCallback(async () => {
    if (!deferred) return
    try {
      await deferred.prompt()
      const { outcome } = await deferred.userChoice
      // The event is single-use either way: a dismissed prompt cannot be fired again, so drop it
      // rather than leave a button that would silently do nothing on the second tap.
      setDeferred(null)
      if (outcome === 'accepted') setInstalled(true)
    } catch {
      setDeferred(null)
    }
  }, [deferred])

  return {
    offer: installOffer({ standalone: installed, deferred: deferred !== null, ios: isIos(navigator) }),
    promptInstall,
  }
}
