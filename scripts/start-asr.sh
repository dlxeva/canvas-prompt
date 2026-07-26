#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${CANVAS_PROMPT_RUNTIME_DIR:-$ROOT_DIR/.canvas-prompt-runtime}"
PORT="${CANVAS_PROMPT_ASR_PORT:-8080}"
ASR_URL="http://127.0.0.1:${PORT}"
PID_FILE="$RUNTIME_DIR/asr.pid"
LOG_FILE="$RUNTIME_DIR/asr.log"

healthy_asr() {
  local response compatible
  response="$(curl --silent --show-error --max-time 2 "$ASR_URL/health" 2>/dev/null || true)"
  compatible="$(printf '%s' "$response" | python3 -c '
import json, sys
try:
  value = json.load(sys.stdin)
  supported = value.get("canvas_prompt_asr") is True or value.get("backend") in {"whisper", "faster-whisper"}
  print("yes" if value.get("status") == "ok" and value.get("whisper_loaded", True) is not False and supported else "no")
except Exception:
  print("no")
' 2>/dev/null || true)"
  [[ "$compatible" == "yes" ]]
}

if healthy_asr; then
  echo "Reusing Canvas Prompt local ASR at $ASR_URL" >&2
  exit 0
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already used by a service whose ASR health endpoint is not compatible with Canvas Prompt." >&2
  exit 1
fi

ASR_PYTHON="$("$ROOT_DIR/scripts/bootstrap-runtime.sh" --with-asr | tail -n 1)"
mkdir -p "$RUNTIME_DIR"
if [[ -f "$PID_FILE" ]] && ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then rm -f "$PID_FILE"; fi

nohup "$ASR_PYTHON" "$ROOT_DIR/runtime/asr-server.py" --host 127.0.0.1 --port "$PORT" >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

echo "Starting Canvas Prompt local ASR at $ASR_URL. On first launch the base speech model downloads to the local cache (about 148 MB)." >&2
for _ in {1..240}; do
  if healthy_asr; then
    echo "Canvas Prompt local ASR is ready at $ASR_URL" >&2
    exit 0
  fi
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Canvas Prompt local ASR exited. Log: $LOG_FILE" >&2
    exit 1
  fi
  sleep 0.5
done

echo "Canvas Prompt local ASR is still preparing. Log: $LOG_FILE" >&2
exit 1
