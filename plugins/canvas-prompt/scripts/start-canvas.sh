#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CALLER_DIR="$PWD"
PROJECT_DIR="${CANVAS_PROMPT_PROJECT_DIR:-${1:-$CALLER_DIR}}"
PORT="${CANVAS_PROMPT_PORT:-43223}"
CORE_APP_DIR="$ROOT_DIR/app"
export CANVAS_PROMPT_PROJECT_DIR="$PROJECT_DIR"

port_pids() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

is_healthy_current_canvas() {
  local candidate="$1"
  local pid command page
  pid="$(port_pids "$candidate" | head -n 1)"
  [ -n "$pid" ] || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"$CORE_APP_DIR"* ]] || return 1
  page="$(curl --silent --show-error --max-time 1 "http://127.0.0.1:${candidate}/" 2>/dev/null || true)"
  [[ "$page" == *"<title>Canvas Prompt</title>"* ]]
}

stop_stale_canvas() {
  local candidate="$1"
  local pid command
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    if [[ "$command" == *"/canvas-prompt/"* && "$command" == *"vite"* ]]; then
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

if [ ! -f "$CORE_APP_DIR/package.json" ]; then
  echo "Canvas Prompt core app was not found: $CORE_APP_DIR/package.json" >&2
  exit 1
fi

cd "$CORE_APP_DIR"
if [ ! -d node_modules ] || [ ! -x node_modules/.bin/vite ]; then npm install; fi
PORT_SELECTION="$(select_port)"
if [[ "$PORT_SELECTION" == reuse:* ]]; then exit 0; fi
PORT="$PORT_SELECTION"
echo "Starting Canvas Prompt on http://127.0.0.1:${PORT}"
echo "Canvas core: ${CORE_APP_DIR}"
echo "Prompt Package: ${PROJECT_DIR}/.canvas-prompt/latest-prompt-package.json"
exec npm run dev -- --host 127.0.0.1 --port "$PORT"
