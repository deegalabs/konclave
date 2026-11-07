// One command to opt in to the local hooks: points git at the tracked .githooks folder.
// It lives in the shared git config, so every worktree picks it up. Not wired into `prepare`
// on purpose: an install in Docker or CI must not depend on git.
import { execFileSync } from 'node:child_process'
execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' })
console.log('Hooks installed: core.hooksPath = .githooks')
