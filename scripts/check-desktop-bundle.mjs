// The desktop release must ship a bundle that knows its coordinator and relay (#664).
//
// The desktop build used to run `pnpm -C ui run build` with neither `VITE_HELPER_BASE` nor
// `VITE_RELAY_BASE` set. Vite inlines `import.meta.env` at build time, so `ui/src/helper.ts` read the
// helper base as '' and the "Konclave-hosted" option never appeared; the relay base fell back to the
// app's own origin, where no relay answers. Nothing failed: the installers built, attached and
// shipped. This check is what makes that build fail instead.
//
// It asks two things of the build, and both are needed:
//   1. both variables are set, non-empty, and https origins (nothing after the host);
//   2. the built JavaScript in `ui/dist/assets` carries each one as Vite inlines it: the variable's
//      own key with exactly that value, `VITE_HELPER_BASE:"https://helper.konclave.xyz"` (any quote
//      Vite picks). The URL in a comment, under another key, or as the start of a longer host does
//      not count. A variable set on the wrong step, or a build that ignored it, passes 1 and fails 2.
//
// The rule only; the workflow runs `scripts/check-desktop-bundle-cli.mjs`, which has no "am I the
// main module?" test to get wrong (see check-sw-cli.mjs for why that matters on Windows).

/** The variables the desktop bundle must carry, in the order they are reported. */
export const REQUIRED = ['VITE_HELPER_BASE', 'VITE_RELAY_BASE']

/** Why `value` is not a usable base for `name`, or null when it is. */
export function invalidBase(name, value) {
  if (value === undefined || value.trim() === '') return `${name} is empty: the desktop app would build without it`
  let u
  try { u = new URL(value) } catch { return `${name} is not a URL: ${JSON.stringify(value)}` }
  if (u.protocol !== 'https:') return `${name} must be https: ${value}`
  if (value !== u.origin) return `${name} must be an origin with nothing after the host (as the coordinator matches it): ${value}`
  return null
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when `source` carries `name` inlined with exactly `value`: `name: "value"`, the key bare or
 *  quoted, the value in any JS quote, and the closing quote right after the value. */
export function carries(source, name, value) {
  const re = new RegExp(`(?:^|[^\\w$])(["'\`]?)${escapeRe(name)}\\1\\s*:\\s*(["'\`])${escapeRe(value)}\\2`)
  return re.test(source)
}

/** Every problem with this env and these built sources; an empty list means the bundle is good. */
export function bundleProblems(env, sources) {
  const problems = []
  for (const name of REQUIRED) {
    const value = env[name]
    const bad = invalidBase(name, value)
    if (bad) { problems.push(bad); continue }
    if (!sources.some((s) => carries(s, name, value))) problems.push(`${name}=${value} is set but not in the built bundle`)
  }
  return problems
}
