#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CALLER_DIR="$PWD"
PROJECT_DIR="${CANVAS_PROMPT_PROJECT_DIR:-${1:-$CALLER_DIR}}"
PORT="${CANVAS_PROMPT_PORT:-43223}"
ASR_URL="${CANVAS_PROMPT_ASR_URL:-http://127.0.0.1:${CANVAS_PROMPT_ASR_PORT:-8080}}"
ASR_ENABLED="${CANVAS_PROMPT_ASR:-enabled}"
DELIVERY_MODE="${CANVAS_PROMPT_DELIVERY_MODE:-local}"
CORE_APP_DIR="$ROOT_DIR/app"
RUNNER="$ROOT_DIR/scripts/run-canvas-service.sh"
export CANVAS_PROMPT_PROJECT_DIR="$PROJECT_DIR"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd -P)"
export CANVAS_PROMPT_PROJECT_DIR="$PROJECT_DIR"

port_pids() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

runtime_project_dir() {
  local candidate="$1" identity
  identity="$(curl --silent --show-error --max-time 1 "http://127.0.0.1:${candidate}/api/runtime-identity" 2>/dev/null || true)"
  [ -n "$identity" ] || return 1
  printf '%s' "$identity" | python3 -c 'import json, sys; value=json.load(sys.stdin); print(value["project_dir"])' 2>/dev/null
}

is_healthy_canvas() {
  local candidate="$1"
  local pid command page
  pid="$(port_pids "$candidate" | head -n 1)"
  [ -n "$pid" ] || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  # A Canvas service installed by an earlier plugin cache has a different core
  # path. It is still a healthy Canvas service and must be treated as owned by
  # its runtime project, never killed merely because this launcher is newer.
  [[ "$command" == *"canvas-prompt"* && "$command" == *"vite"* ]] || return 1
  page="$(curl --silent --show-error --max-time 1 "http://127.0.0.1:${candidate}/" 2>/dev/null || true)"
  [[ "$page" == *"<title>Canvas Prompt</title>"* ]] || return 1
  runtime_project_dir "$candidate" >/dev/null
}

is_healthy_current_canvas() {
  local candidate="$1" running_project
  is_healthy_canvas "$candidate" || return 1
  running_project="$(runtime_project_dir "$candidate")"
  [[ "$running_project" == "$PROJECT_DIR" ]]
}

stop_stale_canvas() {
  local candidate="$1"
  local pid command
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    # Never terminate another healthy Canvas instance: its data belongs to a
    # different business project. Only a process that cannot prove runtime
    # identity is considered stale.
    if [[ "$command" == *"/canvas-prompt/"* && "$command" == *"vite"* ]] && ! is_healthy_canvas "$candidate"; then
      echo "Stopping stale Canvas Prompt server (PID ${pid}) on port ${candidate}." >&2
      kill "$pid" 2>/dev/null || true
    fi
  done < <(port_pids "$candidate")
}

select_port() {
  local candidate="$PORT"
  local attempts=0
  while [ "$attempts" -lt 20 ]; do
    if [ -z "$(port_pids "$candidate")" ]; then
      printf '%s' "$candidate"
      return 0
    fi
    if is_healthy_current_canvas "$candidate"; then
      echo "Canvas Prompt is already running at http://127.0.0.1:${candidate}/" >&2
      printf 'reuse:%s' "$candidate"
      return 0
    fi
    if is_healthy_canvas "$candidate"; then
      echo "Canvas Prompt on port ${candidate} belongs to another project; selecting another port." >&2
      candidate=$((candidate + 1))
      attempts=$((attempts + 1))
      continue
    fi
    stop_stale_canvas "$candidate"
    if [ -z "$(port_pids "$candidate")" ]; then
      printf '%s' "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
    attempts=$((attempts + 1))
  done
  echo "Could not find a free Canvas Prompt port between ${PORT} and $((PORT + 19))." >&2
  exit 1
}

# The integration test sources the port-selection functions with mocked
# process/network commands. It must not install dependencies or start Vite.
if [[ "${CANVAS_PROMPT_TEST_ONLY:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

if [ ! -f "$CORE_APP_DIR/package.json" ]; then
  echo "Canvas Prompt core app was not found: $CORE_APP_DIR/package.json" >&2
  exit 1
fi

"$ROOT_DIR/scripts/bootstrap-runtime.sh" --core-only
cd "$CORE_APP_DIR"
PORT_SELECTION="$(select_port)"
if [[ "$PORT_SELECTION" == reuse:* ]]; then exit 0; fi
PORT="$PORT_SELECTION"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Starting Canvas Prompt on http://127.0.0.1:${PORT}"
  echo "Canvas core: ${CORE_APP_DIR}"
  echo "Prompt Package: ${PROJECT_DIR}/.canvas-prompt/latest-prompt-package.json"
  exec npm run dev -- --host 127.0.0.1 --port "$PORT"
fi

NODE_BIN="$(command -v node)"
SERVICE_ID="$(printf '%s' "${ROOT_DIR}:${PROJECT_DIR}:${PORT}" | shasum -a 256 | cut -c1-12)"
SERVICE_LABEL="com.canvas-prompt.${SERVICE_ID}"
SERVICE_LOG="${TMPDIR:-/tmp}/${SERVICE_LABEL}.log"

# A prior crashed job can survive without a listener. Remove it before submit.
launchctl bootout "gui/$(id -u)/${SERVICE_LABEL}" >/dev/null 2>&1 || true
launchctl submit -l "$SERVICE_LABEL" -o "$SERVICE_LOG" -e "$SERVICE_LOG" -- \
  "$RUNNER" "$CORE_APP_DIR" "$PROJECT_DIR" "$PORT" "$NODE_BIN" "$ASR_URL" "$ASR_ENABLED" "$DELIVERY_MODE"

for _ in {1..20}; do
  if curl --silent --show-error --max-time 1 "http://127.0.0.1:${PORT}/" 2>/dev/null | grep -q '<title>Canvas Prompt</title>'; then
    echo "Canvas Prompt is running at http://127.0.0.1:${PORT}/"
    echo "Canvas core: ${CORE_APP_DIR}"
    echo "Prompt Package: ${PROJECT_DIR}/.canvas-prompt/latest-prompt-package.json"
    echo "Service: ${SERVICE_LABEL}"
    exit 0
  fi
  sleep 0.25
done

echo "Canvas Prompt did not become ready. Log: ${SERVICE_LOG}" >&2
exit 1
