#!/usr/bin/env bash
# Konclave local bridge (ADR-0004): build the `konclave` bin if needed, then serve the
# UI bundle + JSON API on 127.0.0.1 (loopback only) from inside WSL. Detached, so the
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
( cd "$REPO/orchestrator" && cargo build --bin konclave 2>&1 | tail -3 )

if [ ! -x "$BIN" ]; then echo "ERROR: binary not found at $BIN"; exit 1; fi
if [ ! -f "$REPO/ui/dist/index.html" ]; then
  echo "WARNING: ui/dist missing — run 'npm run build' in ui/ (the .ps1 launcher does this)."
fi

pkill -f 'konclave serve' 2>/dev/null; sleep 0.4

# Live balance (/api/balance) is wired only when the wallet tool + dir are present.
# Overridable per machine; degrades to "configured:false" (mock saldo) when absent.
DEVTOOL="${KONCLAVE_DEVTOOL:-$HOME/konclave-src/zcash-devtool/target/release/zcash-devtool}"
WALLET="${KONCLAVE_WALLET:-$HOME/konclave-slice/wallet}"
SERVER="${KONCLAVE_SERVER:-https://zec.rocks:443}"
WALLET_ARGS=()
if [ -x "$DEVTOOL" ] && [ -f "$WALLET/data.sqlite" ]; then
  WALLET_ARGS=(--devtool "$DEVTOOL" --wallet "$WALLET" --server "$SERVER")
  echo "→ saldo ao vivo: $WALLET"
else
  echo "→ balance in demo mode (wallet not found; live balance off)"
fi

# Real send (FROST ceremony) is enabled only when a ceremony config is provided.
CEREMONY="${KONCLAVE_CEREMONY:-}"
CEREMONY_ARGS=()
if [ -n "$CEREMONY" ] && [ -f "$CEREMONY" ]; then
  CEREMONY_ARGS=(--ceremony "$CEREMONY")
  echo "→ envio ao vivo (cerimônia FROST) habilitado: $CEREMONY"
else
  echo "→ envio desligado (defina KONCLAVE_CEREMONY=<config.json> para habilitar)"
fi

setsid nohup "$BIN" serve --port "$PORT" \
  --web "$REPO/ui/dist" --db "$DB" --demo "${WALLET_ARGS[@]}" "${CEREMONY_ARGS[@]}" \
  > "$HOME/konclave-serve.log" 2>&1 &
sleep 1

if pgrep -f 'konclave serve' >/dev/null; then
  echo "✓ konclave serve em 127.0.0.1:$PORT  (log: ~/konclave-serve.log)"
else
  echo "✗ falhou ao iniciar:"; cat "$HOME/konclave-serve.log"; exit 1
fi
