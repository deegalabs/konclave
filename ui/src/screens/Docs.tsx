import { type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Letterhead } from '../components'
import { useI18n } from '../i18n'
import { SECTIONS, type Block, type Locale } from '../docs/content'
import '../docs.css'

// Inline formatter: renders **bold** and `code` spans inside a plain string.
function rich(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>
    return <span key={i}>{p}</span>
  })
}

function renderBlock(b: Block, loc: Locale, i: number): ReactNode {
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
            {cur.blocks.map((b, i) => renderBlock(b, loc, i))}

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
    </div>
  )
}
