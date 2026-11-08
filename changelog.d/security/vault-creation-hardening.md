- **The shared crates carry the checks of the new vault creation.** `konclave-seal` holds them
  once, and the app (through `konclave-wasm`) and the coordinator (through the orchestrator) both
  read that one definition. Nothing changes for how a vault that already exists is used.
