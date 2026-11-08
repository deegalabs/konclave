- **A payroll's name has a home in the shared core (#296).** The coordinator's proposal record
  carries an optional `title`, and its one rule (`orchestrator::helper::payroll_title`: trimmed, at
  most 120 characters, no control or bidirectional characters) is applied by the coordinator. What a
  member sees is in [ui/CHANGELOG.md](ui/CHANGELOG.md) and
  [helper-server/CHANGELOG.md](helper-server/CHANGELOG.md). The desktop's local bridge names a
  payroll from its description, as before.
