import { useT } from './i18n'

/** The only hosts that are not a warning: the real app, and a developer's own machine. */
const OFFICIAL_HOST = 'www.konclave.xyz'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

/** Whether a `host` (with or without a port) is the real app or this machine. */
export function isExpectedHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '').toLowerCase()
  return name === OFFICIAL_HOST || LOCAL_HOSTS.has(name)
}

/** One line on the create and join dialogs: where the member is, and the only place Konclave lives.
 *  A copy of the app on another host (a lookalike, a preview) looks the same and can take a seat's
 *  share, so on any other host the line also says so in words, and takes the warning colour. */
export function HostNotice({ host = location.host }: { host?: string }) {
  const t = useT()
  const odd = !isExpectedHost(host)
  return (
    <p className={odd ? 'host-notice warn' : 'host-notice'} role={odd ? 'alert' : undefined}>
      {t('host.notice', { host })}
      {odd && <b> {t('host.notice.warn')}</b>}
    </p>
  )
}
