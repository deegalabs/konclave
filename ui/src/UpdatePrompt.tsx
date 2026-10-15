import { useEffect, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useT } from './i18n'
import { parseVersionFile, updateLine, type AppVersion } from './app-version'

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
  // The build that is waiting, read from its own version.json; null until read, or when it cannot be.
  const [next, setNext] = useState<AppVersion | null>(null)

  useEffect(() => {
    if (!needRefresh) return
    try { navigator.vibrate?.(12) } catch { /* no haptics */ }
    let on = true
    // A query no precache entry matches, and no HTTP cache: the file of the build now on the server.
    void fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (on) setNext(parseVersionFile(j)) })
      .catch(() => {})
    return () => { on = false }
  }, [needRefresh])

  const line = needRefresh ? updateLine({ version: __APP_VERSION__, commit: __COMMIT_SHA__ }, next) : ''
  // Each half stays on one row; the arrow between them is where the line may break.
  const [was, now] = line.split(' → ')

  return (
    // The live region stays in the page; the banner comes and goes inside it, so it is announced.
    <div role="status">
      {needRefresh && (
        <div className="pwa-update">
          <div className="pwa-update-txt">
            <b>{t('pwa.title')}</b>
            {line && (
              <span className="pwa-update-ver mono" aria-hidden="true">
                <span className="nw">{was}</span>{' → '}<span className="nw">{now}</span>
              </span>
            )}
            {next && line && (
              <span className="visually-hidden">
                {t(next.version === __APP_VERSION__ ? 'pwa.versionsBuild' : 'pwa.versions', { now: __APP_VERSION__, next: next.version })}
              </span>
            )}
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
      )}
    </div>
  )
}

/** Small "v0.0.0 · abc1234" line, in the app frame (rail foot, the More sheet on a phone) and on the landing. Links the commit to GitHub. */
export function VersionBadge({ className = '' }: { className?: string }) {
  const t = useT()
  return (
    <span className={'version-badge mono ' + className}>
      v{__APP_VERSION__}{' · '}
      {__COMMIT_SHA__ === 'dev'
        ? __COMMIT_SHA__
        : <a href={`${REPO}/commit/${__COMMIT_SHA__}`} target="_blank" rel="noreferrer" aria-label={t('version.commitLink', { sha: __COMMIT_SHA__ })}>{__COMMIT_SHA__}</a>}
    </span>
  )
}
