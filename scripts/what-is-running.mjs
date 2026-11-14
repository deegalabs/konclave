// what-is-running.mjs - is production the deploy the repository records?
// The rules of `check-deployed.mjs --against-lock`: the coordinator against `[deploy_build]` in
// engine/versions.lock on staging, the relay against `relay-server --digest` at that commit (run by
// the caller, never re-implemented), the web against the tip of main, and every preflight against the
// headers the app sends (#466). Staging only warns. The inputs are gathered by against-lock.mjs.

/** The commit of the live `[deploy_build]` table (commented records are ignored). */
export function lockDeployCommit(lockText) {
  let inTable = false
  for (const raw of lockText.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) inTable = line === '[deploy_build]'
    else if (inTable) {
      const m = /^commit\s*=\s*"([0-9a-f]{7,40})"/.exec(line)
      if (m) return m[1]
    }
  }
  throw new Error('engine/versions.lock has no [deploy_build] commit')
}

/** The creation protocol the coordinator ships, from its source. */
export function minCreationIn(mainRs) {
  const m = /^const MIN_CREATION: u32 = (\d+);/m.exec(mainRs)
  if (!m) throw new Error('helper-server/src/main.rs has no MIN_CREATION')
  return Number(m[1])
}

/** Every `X-Konclave-*` header named in the given source, plus Content-Type, sorted. */
export function uiCustomHeaders(source) {
  const names = new Set(['Content-Type'])
  for (const m of source.matchAll(/['"](X-Konclave-[A-Za-z-]+)['"]/g)) names.add(m[1])
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * Whether a reported commit is the recorded one. Short hashes grow with the repository, so this
 * compares by prefix (both at least 7 hex characters). A `-dirty` build is never the recorded one.
 * Returns null when it matches, or the reason it does not.
 */
export function commitMismatch(reported, recorded) {
  if (reported === undefined || reported === null || reported === '') return 'absent'
  const r = String(reported)
  if (r.endsWith('-dirty')) return `${r} was built from a tree with uncommitted changes`
  if (!/^[0-9a-f]{7,40}$/.test(r)) return `${r} is not a commit hash`
  const rec = String(recorded)
  const n = Math.min(r.length, rec.length)
  return r.slice(0, n) === rec.slice(0, n) ? null : `${r} (recorded ${rec.slice(0, Math.max(8, r.length))})`
}

const same = (a, b) => a !== undefined && a !== null && String(a) === String(b)

/**
 * Rows of { level: 'ok' | 'red' | 'warn', name, detail }.
 * Observed hosts carry `health` / `version` / `allow` = null when they did not answer.
 */
export function compareRunning(expected, observed) {
  const rows = []
  const push = (ok, name, detail) => rows.push({ level: ok ? 'ok' : 'red', name, detail })

  for (const c of observed.coordinators) {
    const h = c.health
    if (!h) { push(false, `coordinator ${c.name}`, 'no answer'); continue }
    const why = commitMismatch(h.helper_commit, expected.coordinator.commit)
    push(why === null, `coordinator ${c.name}`, why === null ? `commit ${h.helper_commit}` : `commit ${why}`)
    push(same(h.client?.creation, expected.coordinator.creation), `coordinator ${c.name}`,
      `creation ${h.client?.creation ?? 'absent'} (recorded ${expected.coordinator.creation})`)
  }
  for (const r of observed.relays) {
    const h = r.health
    if (!h) { push(false, `relay ${r.name}`, 'no answer'); continue }
    const ok = same(h.source_digest, expected.relayDigest)
    push(ok, `relay ${r.name}`, ok
      ? `source_digest ${h.source_digest}`
      : `source_digest ${h.source_digest ?? 'absent'}, but the relay's sources at the recorded deploy digest to ` +
        `${expected.relayDigest}: relay-server or konclave-http changed since the relay was last deployed and ` +
        'it was not redeployed with the coordinator, or it runs a build from another commit')
  }
  for (const w of observed.webs) {
    const v = w.version
    if (!v) { push(false, `web ${w.name}`, 'no version.json'); continue }
    const why = commitMismatch(v.commit, expected.web.commit)
    const ok = why === null && same(v.version, expected.web.version)
    push(ok, `web ${w.name}`, ok
      ? `${v.version} / ${v.commit}`
      : `${v.version ?? '?'} / ${v.commit ?? '?'} (expected ${expected.web.version} / ${expected.web.commit.slice(0, 7)}, the tip of main)`)
  }
  for (const p of observed.preflights) {
    if (!p.headers.some((h) => h.startsWith('X-Konclave-'))) {
      push(false, `preflight ${p.name}`, 'the scan of the app found no X-Konclave-* header to ask for'); continue
    }
    if (p.allow === null || p.allow === undefined) { push(false, `preflight ${p.name}`, 'no Access-Control-Allow-Headers'); continue }
    const allowed = new Set(p.allow.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
    const missing = p.headers.filter((h) => !allowed.has(h.toLowerCase()))
    push(missing.length === 0, `preflight ${p.name}`,
      missing.length === 0 ? `allows ${p.headers.join(', ')}` : `does not allow ${missing.join(', ')}`)
  }
  if (observed.staging) {
    const s = observed.staging
    const ok = Boolean(s.commit) && s.serviceCodeEqual
    rows.push({
      level: ok ? 'ok' : 'warn',
      name: 'staging coordinator',
      detail: !s.commit ? 'no answer (information only)'
        : s.serviceCodeEqual ? `${s.commit}, same service code as the staging tip`
          : `${s.commit}, service code differs from the staging tip (information only)`,
    })
  }
  return rows
}

export function exitCodeOf(rows) {
  return rows.some((r) => r.level === 'red') ? 1 : 0
}
