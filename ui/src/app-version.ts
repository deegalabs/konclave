// Which build a screen is, and which one is arriving. The running build knows itself at compile time
// (__APP_VERSION__, __COMMIT_SHA__); the one waiting in the service worker is only known through the
// small version.json every build writes next to index.html.

export interface AppVersion {
  version: string
  commit: string
}

// What a version and a commit look like here: "0.13.0", "abc1234" or "dev". Anything else is not
// shown, so a tampered or broken file cannot put text on the banner.
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const COMMIT = /^(?:[0-9a-f]{7,40}|dev)$/

/** The new build's version file, or null when it cannot be read as one. */
export function parseVersionFile(x: unknown): AppVersion | null {
  if (!x || typeof x !== 'object') return null
  const { version, commit } = x as { version?: unknown; commit?: unknown }
  if (typeof version !== 'string' || typeof commit !== 'string') return null
  if (!VERSION.test(version) || !COMMIT.test(commit)) return null
  return { version, commit }
}

/** "v<old> → v<new>" (with the commits when the version number is the same), or nothing while the
 *  new build is not known or is this one: never a line that could read as the version arriving. */
export function updateLine(cur: AppVersion, next: AppVersion | null): string {
  if (!next || next.commit === cur.commit) return ''
  if (next.version !== cur.version) return `v${cur.version} → v${next.version}`
  return `v${cur.version} · ${cur.commit} → v${next.version} · ${next.commit}`
}
