/// <reference types="node" />
// For tests that pin a rule to the code that carries it. Reads a source file with its comments
// removed, so a line that is commented out, or a comment that names the old call, cannot satisfy the
// pin (#610 review: two pins passed with the call they named wrapped and the original kept in a
// comment). Never imported by the app.
//
// The comments are found by the TypeScript parser, not by patterns: a first version used regular
// expressions and ate code after a `/*` inside a string or a line comment (all of api.ts's imports),
// and kept a `//` comment glued to code, which is exactly where a disguised call would go.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { inject } from 'vitest'

// Every pin parses its file, and many pins read the same file: parse each (path, content) once per
// module instance (vitest gives each test FILE its own, so a full run parsed about 5000 times, #957). The
// content is part of the key, so a path read again after it changed is parsed again.
const memo = new Map<string, { src: string; out: string }>()

// The run-wide cache written by test-setup/strip-cache.ts: `{ "<ts|tsx>:<sha256 of the source>": out }`,
// where `out` is what `stripCommentsOnce` returned. Keyed by kind and content, never by path, so a
// source that is not the one cached (new, edited during the run) misses and is parsed as usual. Any
// failure to read it (no setup, no file, bad JSON) means no cache, never an error.
let served: Record<string, string> | undefined
let parses = 0

function servedStrips(): Record<string, string> {
  if (served) return served
  try {
    const path = inject('stripCache')
    const parsed: unknown = path ? JSON.parse(readFileSync(path, 'utf8')) : {}
    served = parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    served = {}
  }
  return served
}

export function stripCacheKey(fileName: string, src: string): string {
  return `${scriptKind(fileName)}:${createHash('sha256').update(src).digest('hex')}`
}

/** How many sources this module instance parsed itself (cache misses), for the tests that count them. */
export function parseCount(): number {
  return parses
}

export function stripComments(fileName: string, src: string): string {
  const hit = memo.get(fileName)
  if (hit && hit.src === src) return hit.out
  const cached = servedStrips()[stripCacheKey(fileName, src)]
  const out = typeof cached === 'string' ? cached : (parses++, stripCommentsOnce(fileName, src))
  memo.set(fileName, { src, out })
  return out
}

function scriptKind(fileName: string): 'tsx' | 'ts' {
  return fileName.endsWith('x') ? 'tsx' : 'ts'
}

/** The one rule. The cache stores its output; nothing else strips comments. */
export function stripCommentsOnce(fileName: string, src: string): string {
  const kind = scriptKind(fileName) === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind)
  const cuts = new Map<number, number>()
  // JSX text is text: `<p>// note</p>` holds no comment, and reading one there cut the closing tag
  // and the code after it.
  const jsxText: [number, number][] = []
  const visit = (node: ts.Node) => {
    if (ts.isJSDoc(node)) return // inside a comment already cut
    if (ts.isJsxText(node)) { jsxText.push([node.pos, node.end]); return }
    for (const r of ts.getLeadingCommentRanges(src, node.pos) ?? []) cuts.set(r.pos, r.end)
    for (const r of ts.getTrailingCommentRanges(src, node.end) ?? []) cuts.set(r.pos, r.end)
    // `{/* ... */}` in JSX: an expression container with nothing but a comment in it.
    if (ts.isJsxExpression(node) && !node.expression) cuts.set(node.getStart(sf), node.end)
    node.getChildren(sf).forEach(visit)
  }
  visit(sf)
  for (const r of ts.getLeadingCommentRanges(src, sf.endOfFileToken.pos) ?? []) cuts.set(r.pos, r.end)
  const inJsxText = (p: number) => jsxText.some(([a, b]) => p >= a && p < b)
  let out = ''
  let at = 0
  for (const [start, end] of [...cuts.entries()].filter(([a]) => !inJsxText(a)).sort((a, b) => a[0] - b[0])) {
    if (start < at) { at = Math.max(at, end); continue }
    out += src.slice(at, start)
    at = end
  }
  return out + src.slice(at)
}

export function codeOf(relativeToSrc: string): string {
  return stripComments(relativeToSrc, readFileSync(new URL(relativeToSrc, import.meta.url), 'utf8'))
}

/** `codeOf` for a file given by its path. */
export function codeAt(path: string): string {
  return stripComments(path, readFileSync(path, 'utf8'))
}
