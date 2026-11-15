import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// #605: the release writes the web manifest, puts its line in the notes, and attaches it before the
// checksums. Read as text by job, like the other workflow tests: the workflow runs only on a tag, so a
// mistake here would otherwise first show on a release.
const wf = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8')
/** The text of one top-level job, comments dropped so a commented line cannot satisfy a check. */
const job = (name: string) => {
  const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|$)`).exec(wf)
  expect(m, name).not.toBeNull()
  return m![1]!.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
}

describe('the web manifest in the release workflow (#605)', () => {
  it('builds both apps with one set of addresses, declared once for the workflow', () => {
    expect(wf).toMatch(/^env:\n  VITE_HELPER_BASE: \S+\n  VITE_RELAY_BASE: \S+$/m)
    expect(job('build')).not.toMatch(/VITE_HELPER_BASE:/)
    expect(job('web')).not.toMatch(/VITE_[A-Z_]+:/)
  })

  it('builds the installers from the tag too, on a manual run', () => {
    expect(job('build')).toMatch(/ref: \$\{\{ inputs\.tag \|\| github\.ref \}\}/)
  })

  it('checks out the tag and refuses a tag that is not the app version', () => {
    const w = job('web')
    expect(w).toMatch(/ref: \$\{\{ inputs\.tag \|\| github\.ref \}\}/)
    expect(w).toMatch(/test "\$\(git rev-parse HEAD\)" = "\$\(git rev-parse "refs\/tags\/\$TAG\^\{commit\}"\)"/)
    expect(w).toMatch(/test "\$TAG" = "v\$version"/)
  })

  it('builds the web app twice and fails when the two manifests differ', () => {
    const w = job('web')
    expect(w.match(/pnpm -C ui run build/g)).toHaveLength(2)
    expect(w).not.toMatch(/KONCLAVE_DESKTOP_BUILD/)
    expect(w).toMatch(/cmp "\$RUNNER_TEMP\/first\.json" web-manifest\.json \|\|/)
    expect(w).toMatch(/node scripts\/check-sw-cli\.mjs web ui\/dist\/sw\.js/)
    expect(w).toMatch(/node scripts\/check-desktop-bundle-cli\.mjs --web ui\/dist/)
  })

  it('attests the manifest with only the permissions that needs', () => {
    const w = job('web')
    expect(w).toMatch(/permissions:\n      contents: read\n      id-token: write\n      attestations: write\n/)
    expect(w).toMatch(/uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d/)
    expect(w).toMatch(/subject-path: web-manifest\.json/)
  })

  it('puts the manifest line in the notes through env, never interpolated into the script', () => {
    const b = job('build')
    expect(b).toMatch(/needs: web/)
    expect(b).toMatch(/WEB_NOTES: \$\{\{ needs\.web\.outputs\.notes \}\}/)
    expect(b).toMatch(/echo "\$WEB_NOTES"/)
    expect(b).toMatch(/test -n "\$WEB_NOTES" \|\|/)
    // The notes are computed on their own line, where a failure stops the step.
    expect(job('web')).toMatch(/\n\s+notes=\$\(node scripts\/web-manifest-cli\.mjs notes web-manifest\.json\)\n\s+test -n "\$notes"/)
    expect(job('web')).not.toMatch(/echo "notes=\$\(/)
    for (const run of b.split(/\n\s+run: \|/).slice(1)) expect(run.split(/\n\s+- /)[0]).not.toMatch(/\$\{\{/)
  })

  it('attaches the manifest before SHA256SUMS, checks its fingerprint, and never replaces one', () => {
    const c = job('checksums')
    expect(c).toMatch(/needs: \[build, web\]/)
    const attach = c.indexOf('gh release upload "$TAG" web-manifest.json')
    const sums = c.indexOf('sha256sum -- *')
    expect(attach).toBeGreaterThan(-1)
    expect(sums).toBeGreaterThan(attach)
    expect(c).toMatch(/echo "\$FINGERPRINT  web-manifest\.json" \| sha256sum -c -/)
    expect(c.slice(0, sums)).not.toMatch(/--clobber/)
  })

  it('checks production against the manifest after attaching it, on a tag push only', () => {
    const c = job('checksums')
    const attach = c.indexOf('gh release upload "$TAG" web-manifest.json')
    const prod = c.indexOf('node scripts/verify-web.mjs --manifest="$RUNNER_TEMP/web-manifest.json" --expect-version="${TAG#v}"')
    expect(prod).toBeGreaterThan(attach)
    expect(c).toMatch(/- name: Production serves this release\n\s+if: github\.event_name == 'push'/)
  })
})
