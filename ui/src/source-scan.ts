/// <reference types="node" />
// For tests that pin a rule to the code that carries it. Reads a source file with its comments
// removed, so a line that is commented out, or a comment that names the old call, cannot satisfy the
// pin (#610 review: two pins passed with the call they named wrapped and the original kept in a
// comment). Never imported by the app.
//
// The comments are found by the TypeScript parser, not by patterns: a first version used regular
// expressions and ate code after a `/*` inside a string or a line comment (all of api.ts's imports),
// and kept a `//` comment glued to code, which is exactly where a disguised call would go.
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Every pin parses its file, and many pins read the same file: parse each (path, content) once per
// worker. The content is part of the key, so a path read again after it changed is parsed again.
const memo = new Map<string, { src: string; out: string }>()

export function stripComments(fileName: string, src: string): string {
  const hit = memo.get(fileName)
  if (hit && hit.src === src) return hit.out
  const out = stripCommentsOnce(fileName, src)
  memo.set(fileName, { src, out })
  return out
}

function stripCommentsOnce(fileName: string, src: string): string {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
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
