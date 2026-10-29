import { Mark } from '../components'
import { useT } from '../i18n'

/** 404 - the catch-all route. A real "page not found" instead of silently falling back to a
 *  default screen, with a clear way back to the vaults. Standalone (no rail). */
export default function NotFound() {
  const t = useT()
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, position: 'relative', zIndex: 1 }}>
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}><Mark /></div>
        <div className="klab">{t('notFound.label')}</div>
        <h1 className="h1" style={{ marginTop: 6 }}>{t('notFound.title')}</h1>
        <p className="dim" style={{ marginTop: 8 }}>{t('notFound.lead')}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22 }}>
          <a className="btn ok" href="#/vaults">{t('notFound.vaults')}</a>
          <a className="btn ghost" href="#/intro">{t('notFound.how')}</a>
        </div>
      </div>
    </div>
  )
}
