#!/usr/bin/env bash
# The ONE recipe for the browser package of konclave-wasm (ui/src/wasm-pkg). CI runs it and compares the
# result with the committed package byte for byte; a person who changes the Rust runs it with --install.
#
#   scripts/build-wasm-pkg.sh <out-dir>            build into <out-dir> (CI: /tmp/pkg)
#   scripts/build-wasm-pkg.sh --install            build, then replace the four files of ui/src/wasm-pkg
#
# Why the flags: the .wasm embeds the absolute path of every source file it was compiled from (panic
# locations: the cargo registry and the checkout). Two machines then produce different bytes from the
# same source, and a byte for byte comparison on a runner can never pass. The paths are remapped to fixed
# prefixes, so the bytes depend on the source, the lock file, the compiler (konclave-wasm/rust-toolchain.toml)
# and wasm-pack (0.13.1, which downloads its own wasm-opt), and on nothing about the machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
FILES=(konclave_wasm_bg.wasm konclave_wasm.js konclave_wasm.d.ts konclave_wasm_bg.wasm.d.ts)

if [ "${1:-}" = "--install" ]; then
  INSTALL=1
  OUT="$(mktemp -d)"
else
  INSTALL=0
  OUT="${1:?usage: scripts/build-wasm-pkg.sh <out-dir> | --install}"
fi

export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=${CARGO_HOME_DIR}=/cargo --remap-path-prefix=${ROOT}=/src"
( cd "$ROOT/konclave-wasm" && wasm-pack build --target web --out-dir "$OUT" )

# wasm-pack writes a `.gitignore` with `*` into the output directory; it must never reach ui/src/wasm-pkg,
# where it would make every new file there ignored without a word.
rm -f "$OUT/.gitignore"

if [ "$INSTALL" = 1 ]; then
  for f in "${FILES[@]}"; do cp --remove-destination "$OUT/$f" "$ROOT/ui/src/wasm-pkg/$f"; done
  echo "ui/src/wasm-pkg replaced from this source: $(sha256sum "$ROOT/ui/src/wasm-pkg/konclave_wasm_bg.wasm" | cut -c1-16)"
fi
