import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Letterhead } from '../components'
import { useI18n } from '../i18n'
import { SECTIONS, type Block, type Locale } from '../docs/content'
import '../docs.css'

// Locale-aware inline labels (kept here to avoid touching the shared i18n files).
const LABELS: Record<Locale, { expand: string; close: string }> = {
  'pt-BR': { expand: 'Ampliar diagrama', close: 'Fechar' },
  en: { expand: 'Expand diagram', close: 'Close' },
}

// Inline formatter: renders **bold** and `code` spans inside a plain string.
function rich(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>
    const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p)
    if (m) return <a key={i} className="docs-link" href={m[2]}>{m[1]}</a>
    return <span key={i}>{p}</span>
  })
}

/** Fullscreen, accessible lightbox for a diagram. Dark overlay, dialog semantics,
 *  Esc + backdrop close, focus moved in on open and restored to the trigger on close,
 *  a Tab focus-trap, and a scroll/pan area for diagrams larger than the viewport. */
function DiagramLightbox({ src, alt, closeLabel, onClose }: {
  src: string
  alt: string
  closeLabel: string
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const capId = 'docs-lightbox-cap'

  useEffect(() => {
    const node = panelRef.current
    const prev = document.activeElement as HTMLElement | null
    const prevBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const sel = 'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])'
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onCloseRef.current(); return }
      if (e.key !== 'Tab' || !node) return
      const f = Array.from(node.querySelectorAll<HTMLElement>(sel))
      const first = f[0], last = f[f.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevBodyOverflow
      prev?.focus?.()
    }
  }, [])

  return (
    <div className="docs-lightbox" onClick={() => onCloseRef.current()}>
      <div
        ref={panelRef}
        className="docs-lightbox-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={capId}
        onClick={(e) => e.stopPropagation()}
      >
        <button ref={closeRef} type="button" className="docs-lightbox-close" onClick={() => onCloseRef.current()} aria-label={closeLabel}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
          </svg>
        </button>
        <div className="docs-lightbox-scroll">
          <img src={src} alt={alt} />
        </div>
        <figcaption id={capId} className="docs-lightbox-cap">{alt}</figcaption>
      </div>
    </div>
  )
}

function renderBlock(b: Block, loc: Locale, i: number, onExpand: (src: string, alt: string) => void): ReactNode {
  switch (b.k) {
    case 'h':
      return <h2 key={i} className="docs-h">{rich(b.t[loc])}</h2>
    case 'p':
      return <p key={i} className="docs-p">{rich(b.t[loc])}</p>
    case 'ul':
      return (
        <ul key={i} className="docs-ul">
          {b.items.map((it, j) => <li key={j}>{rich(it[loc])}</li>)}
        </ul>
      )
    case 'code':
      return <pre key={i} className="docs-code"><code>{b.t}</code></pre>
    case 'note':
      return <aside key={i} className="docs-note">{rich(b.t[loc])}</aside>
    case 'img': {
      const alt = b.alt[loc]
      const src = b.src
      return (
        <figure key={i} className="docs-fig">
          <div className="docs-fig-scroll">
            <img src={src} alt={alt} loading="lazy" onClick={() => onExpand(src, alt)} />
          </div>
          <button type="button" className="docs-fig-expand" aria-label={LABELS[loc].expand} onClick={() => onExpand(src, alt)}>
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 1.5h4.5V6M6 13.5H1.5V9M13.5 1.5l-5 5M1.5 13.5l5-5" />
            </svg>
          </button>
          <figcaption>{alt}</figcaption>
        </figure>
      )
    }
  }
}

/** The in-app documentation site: a sidebar of sections plus a rendered page,
 *  bilingual via the language toggle in the shared Letterhead. */
export default function Docs() {
  const { locale } = useI18n()
  const loc = locale as Locale
  const { section } = useParams<{ section?: string }>()
  const idx = Math.max(0, SECTIONS.findIndex((s) => s.id === section))
  const cur = SECTIONS[idx]!
  const prev = idx > 0 ? SECTIONS[idx - 1]! : null
  const next = idx < SECTIONS.length - 1 ? SECTIONS[idx + 1]! : null
  const isPT = loc === 'pt-BR'
  const [expanded, setExpanded] = useState<{ src: string; alt: string } | null>(null)

  return (
    <div className="docs">
      <Letterhead
        right={<Link className="docs-toapp" to="/">{isPT ? 'Abrir o app' : 'Open the app'}</Link>}
      />
      <div className="docs-body">
        <aside className="docs-side" aria-label={isPT ? 'Documentação' : 'Documentation'}>
          <div className="docs-side-label">{isPT ? 'Documentação' : 'Documentation'}</div>
          <nav>
            {SECTIONS.map((s) => (
              <Link
                key={s.id}
                to={`/docs/${s.id}`}
                className={'docs-navlink' + (s.id === cur.id ? ' active' : '')}
                aria-current={s.id === cur.id ? 'page' : undefined}
              >
                {s.nav[loc]}
              </Link>
            ))}
          </nav>
        </aside>

        <main className="docs-main">
          <article className="docs-article">
            <span className="docs-eyebrow">Konclave · {isPT ? 'Documentação' : 'Docs'}</span>
            <h1 className="docs-title">{cur.title[loc]}</h1>
            <p className="docs-lead">{rich(cur.lead[loc])}</p>
            {cur.blocks.map((b, i) => renderBlock(b, loc, i, (src, alt) => setExpanded({ src, alt })))}

            <nav className="docs-pager">
              {prev
                ? <Link className="docs-pager-link prev" to={`/docs/${prev.id}`}>
                    <small>{isPT ? 'Anterior' : 'Previous'}</small>
                    <span>{prev.nav[loc]}</span>
                  </Link>
                : <span />}
              {next
                ? <Link className="docs-pager-link next" to={`/docs/${next.id}`}>
                    <small>{isPT ? 'Próximo' : 'Next'}</small>
                    <span>{next.nav[loc]}</span>
                  </Link>
                : <span />}
            </nav>
          </article>
        </main>
      </div>

      {expanded && (
        <DiagramLightbox
          src={expanded.src}
          alt={expanded.alt}
          closeLabel={LABELS[loc].close}
          onClose={() => setExpanded(null)}
        />
      )}
    </div>
  )
}
