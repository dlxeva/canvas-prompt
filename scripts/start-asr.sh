#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${CANVAS_PROMPT_RUNTIME_DIR:-$ROOT_DIR/.canvas-prompt-runtime}"
PORT="${CANVAS_PROMPT_ASR_PORT:-8080}"
ASR_URL="http://127.0.0.1:${PORT}"
PID_FILE="$RUNTIME_DIR/asr.pid"
LOG_FILE="$RUNTIME_DIR/asr.log"
SERVICE_LABEL=""
ALLOW_EXTERNAL_ASR="${CANVAS_PROMPT_ALLOW_EXTERNAL_ASR:-0}"
export CANVAS_PROMPT_ALLOW_EXTERNAL_ASR

healthy_asr() {
  local response compatible
  response="$(curl --silent --show-error --max-time 2 "$ASR_URL/health" 2>/dev/null || true)"
  compatible="$(printf '%s' "$response" | python3 -c '
import json, os, sys
try:
  value = json.load(sys.stdin)
  supported = value.get("canvas_prompt_asr") is True
  if not supported and os.environ.get("CANVAS_PROMPT_ALLOW_EXTERNAL_ASR") == "1":
    supported = value.get("backend") in {"whisper", "faster-whisper"}
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

if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
  # A process detached from a short-lived host command can be terminated with
  # that command on macOS. Keep ASR under the same user-service manager as the
  # canvas so a readiness gate remains true after the launcher returns.
  service_id="$(printf '%s' "${ROOT_DIR}:${PORT}" | shasum -a 256 | cut -c1-12)"
  SERVICE_LABEL="com.canvas-prompt.asr.${service_id}"
  launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
  launchctl submit -l "$SERVICE_LABEL" -o "$LOG_FILE" -e "$LOG_FILE" -- \
    "$ASR_PYTHON" "$ROOT_DIR/runtime/asr-server.py" --host 127.0.0.1 --port "$PORT"
  rm -f "$PID_FILE"
else
  nohup "$ASR_PYTHON" "$ROOT_DIR/runtime/asr-server.py" --host 127.0.0.1 --port "$PORT" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
fi

echo "Starting Canvas Prompt local ASR at $ASR_URL. On first launch the base speech model downloads to the local cache (about 148 MB)." >&2
STARTUP_TIMEOUT_SECONDS="${CANVAS_PROMPT_ASR_STARTUP_TIMEOUT_SECONDS:-600}"
for ((attempt = 0; attempt < STARTUP_TIMEOUT_SECONDS * 2; attempt++)); do
  if healthy_asr; then
    echo "Canvas Prompt local ASR is ready at $ASR_URL" >&2
    exit 0
  fi
  if [[ -n "$SERVICE_LABEL" ]]; then
    if ! launchctl print "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1; then
      echo "Canvas Prompt local ASR exited. Log: $LOG_FILE" >&2
      exit 1
    fi
  elif ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Canvas Prompt local ASR exited. Log: $LOG_FILE" >&2
    exit 1
  fi
  sleep 0.5
done

echo "Canvas Prompt local ASR is still preparing after ${STARTUP_TIMEOUT_SECONDS}s. It may still be downloading the model. Log: $LOG_FILE" >&2
exit 1
