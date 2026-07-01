#!/usr/bin/env bash
# Konclave local bridge (ADR-0004): build the `konclave` bin if needed, then serve the
# Rosto bundle + JSON API on 127.0.0.1 (loopback only) from inside WSL. Detached, so the
# Windows launcher returns while the daemon keeps running.
#
# Repo root is derived from this script's location — no hardcoded personal paths.
set -uo pipefail
source "$HOME/.cargo/env" 2>/dev/null || true

PORT="${1:-4762}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/ktarget}"
BIN="$CARGO_TARGET_DIR/debug/konclave"
DB="$HOME/konclave-demo.db"

echo "→ building konclave bin…"
( cd "$REPO/orquestrador" && cargo build --bin konclave 2>&1 | tail -3 )

if [ ! -x "$BIN" ]; then echo "ERRO: bin não encontrado em $BIN"; exit 1; fi
if [ ! -f "$REPO/rosto/dist/index.html" ]; then
  echo "AVISO: rosto/dist não existe — rode 'npm run build' em rosto/ (o launcher .ps1 já faz isso)."
fi

pkill -f 'konclave serve' 2>/dev/null; sleep 0.4
setsid nohup "$BIN" serve --port "$PORT" \
  --web "$REPO/rosto/dist" --db "$DB" --demo \
  > "$HOME/konclave-serve.log" 2>&1 &
sleep 1

if pgrep -f 'konclave serve' >/dev/null; then
  echo "✓ konclave serve em 127.0.0.1:$PORT  (log: ~/konclave-serve.log)"
else
  echo "✗ falhou ao iniciar:"; cat "$HOME/konclave-serve.log"; exit 1
fi
