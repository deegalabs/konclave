- **A vault created before 8 November 2026 and restored on a coordinator without its device
  registry takes unsigned actions again,** and approvals recorded without a signature count again,
  until its members unlock and register. A vault created since then does not open: it refuses
  votes, proposals and sends instead. Whoever runs the coordinator restores the registry with the
  vault, from the backup (`docs/RECOVERY.md`, D and G), and tells the members when none exists.
