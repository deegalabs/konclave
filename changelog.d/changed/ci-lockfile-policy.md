- **CI now checks the committed lockfile against the dependency supply-chain settings** (#820). A
  separate job runs pnpm 12, pinned by the integrity of its tarballs and only to verify, because it
  re-applies the minimum release age and the trust policy to every locked entry, which pnpm 10's
  `--frozen-lockfile` install does not. It first refuses settings weaker than the ones documented:
  the settings pnpm resolves must be on an allowlist (a shorter age, an exclude that is not one
  exact version, another registry or any other key is refused), `.npmrc` may set nothing but
  `engine-strict`, and no pnpmfile runs. Then it proves the check is live: with the trust
  excludes removed it must refuse `semver@6.3.1`, and with an absurd minimum age it must refuse on
  age. A registry it cannot reach is reported as "could not verify", never as a pass, and the jobs
  that install fail when the check did not pass. Its first run found a third locked package the
  trust policy refuses, which the 0.21.0 entry, counting two, had missed: `undici-types@6.21.0`
  (type definitions that `@types/node` requires, published without the provenance its earlier
  releases carried), now excluded by exact version with its reason in `pnpm-workspace.yaml`.
