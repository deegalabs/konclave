// The desktop release must ship a bundle that knows its coordinator and relay (#664).
//
// The desktop build used to run `pnpm -C ui run build` with neither `VITE_HELPER_BASE` nor
// `VITE_RELAY_BASE` set. Vite inlines `import.meta.env` at build time, so `ui/src/helper.ts` read the
// helper base as '' and the "Konclave-hosted" option never appeared; the relay base fell back to the
// app's own origin, where no relay answers. Nothing failed: the installers built, attached and
// shipped. This check is what makes that build fail instead.
//
// It asks three things of the build:
//   1. both variables are set, non-empty, and https origins (nothing after the host);
//   2. the built JavaScript in `ui/dist/assets` carries each value as Vite inlines a static read
//      (`import.meta.env.VITE_HELPER_BASE`): a whole string literal, exactly that value, in any quote
//      Vite picks. The URL in a comment, inside a longer string, or as the start of a longer host
//      does not count. A variable set on the wrong step, or a build that ignored it, passes 1 and
//      fails 2;
//   3. no env key NAME survives in the built JavaScript (#605). A key name in the bundle means a
//      whole env object was inlined, which carries every VITE_* variable the build saw, including
//      the ones the host adds on its own (Vercel injects one), so the bytes stop being reproducible
//      from the repository and no published manifest can match them. The web build (ci.yml) runs
//      this third rule alone, with `--web`: it has no addresses to require.
// Until #605 the rule was the opposite (the key next to its value), because the app read the env
// as an object; both halves live here so the two cannot drift apart again.
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

/** True when `source` carries `value` as one whole string literal: the same quote on both sides,
 *  nothing else inside. */
export function carries(source, value) {
  const re = new RegExp(`(["'\`])${escapeRe(value)}\\1`)
  return re.test(source)
}

/** The distinct env key names in `source`, as whole words (`INVITE_LENGTH` is not one), sorted. */
export function envKeysIn(source) {
  const names = new Set()
  for (const m of source.matchAll(/(?<![\w$])VITE_[A-Z0-9_]+(?![\w$])/g)) names.add(m[0])
  return [...names].sort()
}

/** Every problem with this env and these built sources; an empty list means the bundle is good.
 *  `web: true` checks rule 3 alone. */
export function bundleProblems(env, sources, { web = false } = {}) {
  const problems = []
  if (!web) {
    for (const name of REQUIRED) {
      const value = env[name]
      const bad = invalidBase(name, value)
      if (bad) { problems.push(bad); continue }
      if (!sources.some((s) => carries(s, value))) problems.push(`${name}=${value} is set but not in the built bundle`)
    }
  }
  const keys = new Set(sources.flatMap(envKeysIn))
  for (const k of [...keys].sort()) {
    problems.push(`the bundle carries the env key ${k}: an env object was inlined, so its bytes depend on whatever variables the host sets (read import.meta.env.VITE_<NAME> directly)`)
  }
  return problems
}
