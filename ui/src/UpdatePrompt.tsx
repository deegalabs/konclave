import { useEffect, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useT } from './i18n'

const REPO = 'https://github.com/deegalabs/konclave'

/**
 * Registers the PWA service worker and shows a "new version available" banner when a new build is
 * waiting (registerType: 'prompt'). The user taps to apply — a member mid-ceremony is never yanked
 * into a reload. Polls for updates every 60s so an app left open for hours still picks up a deploy.
 */
export function UpdatePrompt() {
  const t = useT()
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, r) {
      if (r) setInterval(() => { r.update().catch(() => {}) }, 60_000)
    },
  })
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (needRefresh) { try { navigator.vibrate?.(12) } catch { /* no haptics */ } }
  }, [needRefresh])

  if (!needRefresh) return null

  return (
    <div className="pwa-update" role="alert" aria-live="polite">
      <div className="pwa-update-txt">
        <b>{t('pwa.title')}</b>
        <span className="pwa-update-ver mono">v{__APP_VERSION__} · {__COMMIT_SHA__}</span>
      </div>
      <button
        className="btn ok sm-btn"
        disabled={applying}
        onClick={async () => {
          setApplying(true)
          try {
            await updateServiceWorker(true)
            // Some installed PWAs swallow controllerchange; force the reload if it hangs.
            setTimeout(() => location.reload(), 2000)
          } catch {
            location.reload()
          }
        }}
      >
        {applying ? t('pwa.updating') : t('pwa.refresh')}
      </button>
      <button type="button" className="pwa-update-x" aria-label={t('pwa.dismiss')} onClick={() => setNeedRefresh(false)}>×</button>
    </div>
  )
}

/** Small "v0.0.0 · abc1234" line (footer). Links the commit to GitHub. */
export function VersionBadge({ className = '' }: { className?: string }) {
  return (
    <span className={'version-badge mono ' + className}>
      v{__APP_VERSION__}{' · '}
      {__COMMIT_SHA__ === 'dev'
        ? __COMMIT_SHA__
        : <a href={`${REPO}/commit/${__COMMIT_SHA__}`} target="_blank" rel="noreferrer">{__COMMIT_SHA__}</a>}
    </span>
  )
}
