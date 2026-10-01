// The desktop version that is PUBLISHED on GitHub Releases, which the landing links to and the docs
// name. It is bumped in the follow-up PR after a release is published, not at the cut:
// `scripts/release.mjs` moves ui/package.json (and so __APP_VERSION__) when the installers do not exist
// yet, and a link built from that would 404 until the draft is published.
//
// One constant for both, because there were two: #598 moved the landing to v0.8.0 and left two
// sentences in the docs naming v0.7.0.
export const DESKTOP_VERSION = '0.8.0'
