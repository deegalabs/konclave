import { useT } from './i18n'
import { PUBLIC_APP } from './net'
import { isDesktop } from './platform'

/** The only hosts that are not a warning: the real app (derived from the one address invites use),
 *  and a developer's own machine. Preview hosts, konclave-demo.vercel.app among them, are NOT here:
 *  they warn. */
const OFFICIAL_HOST = new URL(PUBLIC_APP).host
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

/** Whether a `host` (with or without a port) is the real app or this machine. */
export function isExpectedHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === OFFICIAL_HOST || LOCAL_HOSTS.has(name)
}

/** The id the dialogs point `aria-describedby` at, so a screen reader reads the notice with the
 *  dialog's name instead of depending on a live region firing while focus moves. */
const MARK = '\u0000'
export const HOST_NOTICE_ID = 'host-notice'

/** One line on the create, join, import and unlock screens: where the member is, and the only place
 *  Konclave lives. A copy served unchanged from another host (a preview, a mirror, a proxy) is
 *  caught by it, so on any other host the line also says so in words and takes the warning colour.
 *  A modified copy can remove it: the browser's address bar is the check that counts.
 *
 *  The desktop app has no address bar and its own origin (http://tauri.localhost on Windows), which
 *  would read as a stranger, so there it shows nothing: the app on the member's disk is not served
 *  from anywhere. `alert` is false while an error is on the same screen, so two alerts never
 *  compete. */
export function HostNotice({ host = location.host, alert = true }: { host?: string; alert?: boolean }) {
  const t = useT()
  if (isDesktop) return null
  const odd = !isExpectedHost(host)
  // The host sits in its own element (mono, breakable), so a long lookalike cannot start a line
  // with the official name as if it were part of the sentence.
  const [before, after] = t('host.notice', { host: MARK }).split(MARK)
  return (
    <p id={HOST_NOTICE_ID} className={odd ? 'host-notice warn' : 'host-notice'} role={odd && alert ? 'alert' : undefined}>
      {before}<strong className="host-notice-host">{host}</strong>{after}
      {odd && <> <strong>{t('host.notice.warn')}</strong></>}
    </p>
  )
}
