- **The lockfile check does not cover every install.** The desktop release workflow and the Vercel
  preview build install without it in front of them, and no control shows that `blockExoticSubdeps`
  is re-applied to entries already in the lockfile (the lockfile holds no git or tarball entry for
  it to refuse). This narrows the 0.21.0 limit "CI does not enforce the dependency supply-chain
  settings".
