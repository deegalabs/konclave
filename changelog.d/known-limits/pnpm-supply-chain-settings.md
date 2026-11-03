- **CI does not enforce these settings.** They act when pnpm resolves dependencies, and CI installs
  with `--frozen-lockfile`, which does not. A lockfile that already holds something they would have
  refused still installs in CI. They guard the moment a contributor changes the lockfile, not the
  lockfile itself.
